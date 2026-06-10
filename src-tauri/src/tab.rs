use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use crossbeam_channel::{bounded, select, unbounded, Receiver, Sender};
use libghostty_vt::{
    render::{CellIterator, CursorVisualStyle, Dirty, RenderState, RowIterator},
    screen::{CellWide, Screen},
    style::{RgbColor, StyleColor},
    terminal::{Point, PointCoordinate, ScrollViewport},
    Terminal, TerminalOptions,
};
use parking_lot::Mutex;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, EventTarget};

use crate::{
    config::Theme,
    error::{AppError, AppResult},
    platform,
    protocol::{
        CellWire, CursorWire, ExitPayload, RenderPayload, TabInfo, CURSOR_STYLE_BAR,
        CURSOR_STYLE_BLOCK, CURSOR_STYLE_BLOCK_HOLLOW, CURSOR_STYLE_UNDERLINE, FLAG_BOLD,
        FLAG_FAINT, FLAG_INVERSE, FLAG_ITALIC, FLAG_SPACER_TAIL, FLAG_STRIKETHROUGH,
        FLAG_UNDERLINE, FLAG_WIDE,
    },
    SharedConfig,
};

/// Bounded capacity of the per-tab PTY-*write* queue (terminal replies +
/// user input). Replies are dropped when full so a child that floods output
/// without reading its own stdin (`cat /dev/urandom`) cannot jam the PTY input
/// queue and stall the VT thread (which also blocked CTRL+C from reaching the
/// line discipline). Interactive apps drain their input and never hit this.
const PTY_WRITE_QUEUE_CAP: usize = 1024;

/// When the user presses CTRL+C and this many PTY-output chunks are already
/// buffered, the foreground process is being interrupted while a flood is in
/// flight (e.g. `cat /dev/urandom`). Those buffered bytes are about-to-be-killed
/// output; discard them so the screen stops immediately instead of scrolling
/// the stale backlog for seconds. Normal commands never buffer this deep (the
/// loop drains them faster than they arrive), so their output is untouched.
const INTERRUPT_FLUSH_BACKLOG: usize = 64;

/// Max arrow-key presses a single mouse-wheel event may inject into an
/// alternate-screen app. Caps a fast flick so it can't flood the PTY.
const WHEEL_ARROW_CAP: u32 = 50;

#[derive(Clone, Copy, Debug)]
pub enum ScrollKind {
    Top,
    Bottom,
    LineUp,
    LineDown,
    PageUp,
    PageDown,
    Delta(i32),
}

pub enum TabCmd {
    Write(Vec<u8>),
    Resize {
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
    },
    Scroll(ScrollKind),
    /// Physical mouse-wheel notch, in rows (negative = up/away from the user).
    /// Routed smartly on the tab thread: translated to arrow keys for an
    /// alternate-screen app with no mouse tracking, otherwise a viewport scroll.
    Wheel(i32),
    /// Extract the text of a screen-absolute coordinate range (inclusive) and
    /// send it back on `reply`. Coordinates are `(col, screen_row)` where
    /// `screen_row` is relative to the top of the scrollback — the same
    /// coordinate space the frontend tracks selections in. Used for copy,
    /// which must reach rows outside the current viewport snapshot.
    CopyText {
        start: (u16, u32),
        end: (u16, u32),
        reply: Sender<String>,
    },
    SetWindow(String),
    Shutdown,
}

pub enum PtyEvent {
    Data(Vec<u8>),
    Eof,
}

/// Outbound commands for an SSH session's tokio task — shared with
/// `crate::ssh`. Keeping this here lets `tab.rs` own the I/O abstraction
/// without taking a hard dependency on the ssh module's internals.
pub enum SshIoCmd {
    Write(Vec<u8>),
    Resize {
        cols: u16,
        rows: u16,
        w_px: u32,
        h_px: u32,
    },
    Close,
}

/// SFTP requests routed from async Tauri command handlers into the SSH
/// session task (which owns the `SftpSession` on the SSH runtime). Each
/// carries a oneshot reply so the command can await the result. Metadata
/// ops are served inline on the session task; transfers are spawned so a
/// large file doesn't stall shell I/O. Mirrors how `SshIoCmd` keeps the
/// tab side free of any russh/sftp types.
pub enum SftpReq {
    List {
        path: String,
        reply: tokio::sync::oneshot::Sender<AppResult<Vec<crate::protocol::SftpEntry>>>,
    },
    Realpath {
        path: String,
        reply: tokio::sync::oneshot::Sender<AppResult<String>>,
    },
    Stat {
        path: String,
        reply: tokio::sync::oneshot::Sender<AppResult<crate::protocol::SftpEntry>>,
    },
    Mkdir {
        path: String,
        reply: tokio::sync::oneshot::Sender<AppResult<()>>,
    },
    Rename {
        from: String,
        to: String,
        reply: tokio::sync::oneshot::Sender<AppResult<()>>,
    },
    Remove {
        path: String,
        is_dir: bool,
        /// Directory deletes run like transfers (spawned, long-running) and
        /// report progress under this id as a count of removed entries.
        transfer_id: u64,
        reply: tokio::sync::oneshot::Sender<AppResult<()>>,
    },
    Download {
        remote: String,
        local: std::path::PathBuf,
        transfer_id: u64,
        reply: tokio::sync::oneshot::Sender<AppResult<()>>,
    },
    Upload {
        local: std::path::PathBuf,
        remote: String,
        transfer_id: u64,
        reply: tokio::sync::oneshot::Sender<AppResult<()>>,
    },
}

/// Where the bytes a tab produces go to (and where its inbound bytes
/// originate). The inbound stream is always a crossbeam `Receiver<PtyEvent>`
/// regardless of source — only the outbound side branches.
pub enum TabIo {
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    LocalPty {
        writer: Box<dyn Write + Send>,
        master: Box<dyn portable_pty::MasterPty + Send>,
        child: Box<dyn portable_pty::Child + Send + Sync>,
    },
    Ssh {
        out_tx: tokio::sync::mpsc::Sender<SshIoCmd>,
    },
}

/// `Write` adapter that pushes outbound bytes into the SSH session task
/// via the tokio mpsc. Called from the tab thread (sync) — uses
/// `blocking_send` which is supported on `tokio::sync::mpsc::Sender`.
struct SshWriter {
    tx: tokio::sync::mpsc::Sender<SshIoCmd>,
}

impl Write for SshWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.tx
            .blocking_send(SshIoCmd::Write(buf.to_vec()))
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::BrokenPipe))?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabKind {
    Local,
    Ssh,
}

impl TabKind {
    pub fn as_wire(self) -> &'static str {
        match self {
            TabKind::Local => "terminal",
            TabKind::Ssh => "ssh",
        }
    }
}

pub struct TabHandle {
    pub id: u64,
    pub cmd_tx: Sender<TabCmd>,
    pub kind: TabKind,
    pub host_id: Option<i64>,
    pub host_label: Option<String>,
    /// Present for SSH tabs whose session offered the SFTP subsystem.
    /// Command handlers clone this to drive the file browser. `None` for
    /// local tabs and for SSH hosts where SFTP is disabled/unavailable.
    pub sftp_tx: Option<tokio::sync::mpsc::Sender<SftpReq>>,
    /// SSH per-host flags, kept so `TabInfo` (hydrate/tear-off) can restore
    /// the right tab chrome in whichever window ends up owning the tab.
    pub disable_sftp: bool,
    pub disable_ssh: bool,
}

pub struct TabRegistry {
    inner: Mutex<HashMap<u64, TabHandle>>,
    windows: Mutex<HashMap<u64, String>>,
    next_id: AtomicU64,
}

impl TabRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            windows: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    /// Allocate a fresh tab id without spawning anything. Used by callers
    /// that need the id before they can build the `TabIo` (notably the
    /// async SSH connect path — we want to register the tab early so the
    /// frontend can show "connecting…" tab UX while russh negotiates).
    pub fn next_tab_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    /// Hand off control of an SSH tab to the shared `run_tab_loop`.
    /// `pty_rx` is fed by the SSH session task; `out_tx` is what the
    /// tab loop uses for outbound bytes/resize/close.
    #[allow(clippy::too_many_arguments)]
    pub fn start_ssh_tab(
        self: &Arc<Self>,
        id: u64,
        app: AppHandle,
        owner_window: String,
        host_id: i64,
        host_label: String,
        cols: u16,
        rows: u16,
        scrollback_lines: usize,
        config: SharedConfig,
        pty_rx: Receiver<PtyEvent>,
        out_tx: tokio::sync::mpsc::Sender<SshIoCmd>,
        sftp_tx: tokio::sync::mpsc::Sender<SftpReq>,
        disable_sftp: bool,
        disable_ssh: bool,
    ) -> AppResult<()> {
        let (cmd_tx, cmd_rx) = unbounded::<TabCmd>();
        self.start_tab_thread(
            id,
            app,
            owner_window.clone(),
            cmd_rx,
            pty_rx,
            TabIo::Ssh {
                out_tx: out_tx.clone(),
            },
            cols,
            rows,
            scrollback_lines,
            config,
        )?;
        self.inner.lock().insert(
            id,
            TabHandle {
                id,
                cmd_tx,
                kind: TabKind::Ssh,
                host_id: Some(host_id),
                host_label: Some(host_label),
                sftp_tx: Some(sftp_tx),
                disable_sftp,
                disable_ssh,
            },
        );
        self.windows.lock().insert(id, owner_window);
        Ok(())
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    pub fn spawn(
        self: &Arc<Self>,
        app: AppHandle,
        owner_window: String,
        cols: u16,
        rows: u16,
        _cell_width_px: u32,
        _cell_height_px: u32,
        shell: Option<String>,
        scrollback_lines: usize,
        config: SharedConfig,
    ) -> AppResult<u64> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Pty(e.to_string()))?;

        let shell_path = platform::resolve_shell(shell);
        // Resolve login args before moving `shell_path` into the builder.
        // The slice is `'static` so it doesn't borrow `shell_path`.
        let login_args: &[&str] = if config.lock().login_shell {
            platform::login_shell_args(&shell_path)
        } else {
            &[]
        };
        let mut cmd = CommandBuilder::new(shell_path);
        for a in login_args {
            cmd.arg(a);
        }
        if let Some(home) = platform::home_dir() {
            cmd.cwd(home);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // When packaged as an AppImage, hand the shell the user's
        // login environment, not our bundled-runtime one (otherwise
        // e.g. `flatpak` crashes on our older bundled GLib). No-op for
        // .deb/.rpm/.app and when not run from an AppImage.
        platform::sanitize_child_env(&mut cmd);

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::Pty(e.to_string()))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::Pty(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::Pty(e.to_string()))?;

        let (cmd_tx, cmd_rx) = unbounded::<TabCmd>();
        let (pty_tx, pty_rx) = unbounded::<PtyEvent>();

        let pty_tx_for_reader = pty_tx.clone();
        thread::Builder::new()
            .name(format!("tab-{id}-reader"))
            .spawn(move || {
                let mut buf = vec![0u8; 8 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => {
                            let _ = pty_tx_for_reader.send(PtyEvent::Eof);
                            break;
                        }
                        Ok(n) => {
                            if pty_tx_for_reader
                                .send(PtyEvent::Data(buf[..n].to_vec()))
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(_) => {
                            let _ = pty_tx_for_reader.send(PtyEvent::Eof);
                            break;
                        }
                    }
                }
            })
            .map_err(|e| AppError::Other(format!("spawn reader thread: {e}")))?;

        self.start_tab_thread(
            id,
            app,
            owner_window.clone(),
            cmd_rx,
            pty_rx,
            TabIo::LocalPty {
                writer,
                master: pair.master,
                child,
            },
            cols,
            rows,
            scrollback_lines,
            config,
        )?;
        self.inner.lock().insert(
            id,
            TabHandle {
                id,
                cmd_tx,
                kind: TabKind::Local,
                host_id: None,
                host_label: None,
                sftp_tx: None,
                disable_sftp: false,
                disable_ssh: false,
            },
        );
        self.windows.lock().insert(id, owner_window);
        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    fn start_tab_thread(
        self: &Arc<Self>,
        id: u64,
        app: AppHandle,
        owner_window: String,
        cmd_rx: Receiver<TabCmd>,
        pty_rx: Receiver<PtyEvent>,
        tab_io: TabIo,
        cols: u16,
        rows: u16,
        scrollback_lines: usize,
        config: SharedConfig,
    ) -> AppResult<()> {
        let app_for_tab = app.clone();
        let registry_for_tab: Arc<Self> = self.clone();
        let owner_for_thread = owner_window;

        thread::Builder::new()
            .name(format!("tab-{id}-main"))
            .spawn(move || {
                let status = match run_tab_loop(
                    id,
                    app_for_tab.clone(),
                    owner_for_thread,
                    cmd_rx,
                    pty_rx,
                    tab_io,
                    cols,
                    rows,
                    scrollback_lines,
                    config,
                ) {
                    Ok(status) => status,
                    Err(e) => {
                        eprintln!("[tab {id}] crashed: {e}");
                        -1
                    }
                };
                match registry_for_tab.window_of(id) {
                    Some(label) => {
                        let _ = app_for_tab.emit_to(
                            EventTarget::webview_window(label),
                            "terminal:exit",
                            ExitPayload { tab_id: id, status },
                        );
                    }
                    None => {
                        let _ = app_for_tab.emit(
                            "terminal:exit",
                            ExitPayload { tab_id: id, status },
                        );
                    }
                }
            })
            .map_err(|e| AppError::Other(format!("spawn tab thread: {e}")))?;
        Ok(())
    }

    pub fn write_input(&self, id: u64, bytes: Vec<u8>) -> AppResult<()> {
        let guard = self.inner.lock();
        let h = guard.get(&id).ok_or(AppError::UnknownTab(id))?;
        h.cmd_tx
            .send(TabCmd::Write(bytes))
            .map_err(|_| AppError::UnknownTab(id))?;
        Ok(())
    }

    pub fn resize(
        &self,
        id: u64,
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
    ) -> AppResult<()> {
        let guard = self.inner.lock();
        let h = guard.get(&id).ok_or(AppError::UnknownTab(id))?;
        h.cmd_tx
            .send(TabCmd::Resize {
                cols,
                rows,
                cell_width_px,
                cell_height_px,
            })
            .map_err(|_| AppError::UnknownTab(id))?;
        Ok(())
    }

    pub fn scroll(&self, id: u64, kind: ScrollKind) -> AppResult<()> {
        let guard = self.inner.lock();
        let h = guard.get(&id).ok_or(AppError::UnknownTab(id))?;
        h.cmd_tx
            .send(TabCmd::Scroll(kind))
            .map_err(|_| AppError::UnknownTab(id))?;
        Ok(())
    }

    pub fn wheel_scroll(&self, id: u64, rows: i32) -> AppResult<()> {
        let guard = self.inner.lock();
        let h = guard.get(&id).ok_or(AppError::UnknownTab(id))?;
        h.cmd_tx
            .send(TabCmd::Wheel(rows))
            .map_err(|_| AppError::UnknownTab(id))?;
        Ok(())
    }

    /// Ask the tab thread for the text of a screen-absolute range (inclusive),
    /// blocking on a reply channel. The terminal lives on the tab thread, so we
    /// round-trip a `TabCmd::CopyText` rather than touching it here.
    pub fn copy_text(&self, id: u64, start: (u16, u32), end: (u16, u32)) -> AppResult<String> {
        let (reply_tx, reply_rx) = bounded::<String>(1);
        {
            let guard = self.inner.lock();
            let h = guard.get(&id).ok_or(AppError::UnknownTab(id))?;
            h.cmd_tx
                .send(TabCmd::CopyText {
                    start,
                    end,
                    reply: reply_tx,
                })
                .map_err(|_| AppError::UnknownTab(id))?;
        }
        reply_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| AppError::Other(format!("tab {id} did not answer copy request within 5s")))
    }

    /// Clone the SFTP request sender for an SSH tab. Errors when the tab is
    /// unknown, is a local tab, or its session never offered SFTP (subsystem
    /// failed / disabled for the host) — the command layer maps that to a
    /// clean "SFTP not available" surfaced in the panel.
    pub fn sftp_sender(&self, id: u64) -> AppResult<tokio::sync::mpsc::Sender<SftpReq>> {
        let guard = self.inner.lock();
        let h = guard.get(&id).ok_or(AppError::UnknownTab(id))?;
        h.sftp_tx
            .clone()
            .ok_or_else(|| AppError::Ssh("SFTP is not available on this connection".into()))
    }

    pub fn close(&self, id: u64) -> AppResult<()> {
        let mut guard = self.inner.lock();
        if let Some(h) = guard.remove(&id) {
            let _ = h.cmd_tx.send(TabCmd::Shutdown);
        }
        self.windows.lock().remove(&id);
        Ok(())
    }

    pub fn list(&self) -> Vec<TabInfo> {
        self.inner
            .lock()
            .values()
            .map(handle_to_info)
            .collect()
    }

    pub fn info(&self, id: u64) -> Option<TabInfo> {
        self.inner.lock().get(&id).map(handle_to_info)
    }

    pub fn forget(&self, id: u64) {
        self.inner.lock().remove(&id);
        self.windows.lock().remove(&id);
    }

    pub fn set_window(&self, id: u64, label: String) -> AppResult<()> {
        // Update the map first (source of truth for command routing), then
        // notify the tab thread so its cached label is in sync for the
        // next render emit.
        let guard = self.inner.lock();
        let h = guard.get(&id).ok_or(AppError::UnknownTab(id))?;
        h.cmd_tx
            .send(TabCmd::SetWindow(label.clone()))
            .map_err(|_| AppError::UnknownTab(id))?;
        drop(guard);
        self.windows.lock().insert(id, label);
        Ok(())
    }

    pub fn window_of(&self, id: u64) -> Option<String> {
        self.windows.lock().get(&id).cloned()
    }

    pub fn tabs_in_window(&self, label: &str) -> Vec<u64> {
        self.windows
            .lock()
            .iter()
            .filter(|(_, l)| l.as_str() == label)
            .map(|(id, _)| *id)
            .collect()
    }
}

#[allow(clippy::too_many_arguments)]
fn run_tab_loop(
    tab_id: u64,
    app: AppHandle,
    mut owner_window: String,
    cmd_rx: Receiver<TabCmd>,
    pty_rx: Receiver<PtyEvent>,
    tab_io: TabIo,
    cols: u16,
    rows: u16,
    scrollback_lines: usize,
    config: SharedConfig,
) -> AppResult<i32> {
    // Build a unified writer + a small backend handle for resize/shutdown.
    enum Backend {
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        Pty {
            master: Box<dyn portable_pty::MasterPty + Send>,
            child: Box<dyn portable_pty::Child + Send + Sync>,
        },
        Ssh {
            out_tx: tokio::sync::mpsc::Sender<SshIoCmd>,
        },
    }

    let (writer, mut backend) = match tab_io {
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        TabIo::LocalPty {
            writer,
            master,
            child,
        } => (writer, Backend::Pty { master, child }),
        TabIo::Ssh { out_tx } => {
            let w: Box<dyn Write + Send> = Box::new(SshWriter {
                tx: out_tx.clone(),
            });
            (w, Backend::Ssh { out_tx })
        }
    };

    // Dedicated PTY-writer thread. `on_pty_write` runs synchronously inside
    // `vt_write` on this (VT) thread, so a blocking write there freezes
    // terminal parsing. A child that floods output without reading its own
    // stdin (e.g. `cat /dev/urandom`, which makes us emit query replies it
    // never drains) fills the PTY input queue; the old direct `write_all`
    // then blocked `vt_write` indefinitely and also kept CTRL+C from reaching
    // the line discipline. Off-loading writes here keeps the VT thread free;
    // replies are dropped if the queue backs up (disposable when the child
    // isn't reading), while user input is sent reliably and is low-volume.
    let (write_tx, write_rx) = bounded::<Vec<u8>>(PTY_WRITE_QUEUE_CAP);
    {
        let mut writer = writer;
        thread::Builder::new()
            .name(format!("tab-{tab_id}-writer"))
            .spawn(move || {
                while let Ok(bytes) = write_rx.recv() {
                    if writer.write_all(&bytes).is_err() {
                        break;
                    }
                    let _ = writer.flush();
                }
            })
            .map_err(|e| AppError::Other(format!("spawn writer thread: {e}")))?;
    }
    let mut terminal = Terminal::new(TerminalOptions {
        cols,
        rows,
        max_scrollback: scrollback_lines,
    })?;
    {
        let tx = write_tx.clone();
        terminal.on_pty_write(move |_t, bytes| {
            // Non-blocking: drop replies if the writer can't keep up so a
            // non-reading flooder can never stall the VT thread.
            let _ = tx.try_send(bytes.to_vec());
        })?;
    }
    let mut render_state = RenderState::new()?;
    let mut row_iter = RowIterator::new()?;
    let mut cell_iter = CellIterator::new()?;
    let mut generation: u64 = 0;
    let mut pending_emit = false;
    let mut emit_count: u64 = 0;
    let mut last_emit = Instant::now();
    let debounce = Duration::from_millis(8);

    let timeout_tick = Duration::from_millis(5);
    loop {
        select! {
            recv(cmd_rx) -> msg => match msg {
                Ok(TabCmd::Write(bytes)) => {
                    let is_interrupt = bytes.contains(&0x03);
                    terminal.scroll_viewport(ScrollViewport::Bottom);
                    pending_emit = true;
                    // Reliable send: input is tiny and must not be dropped. The
                    // queue won't back up from a flood (replies use try_send).
                    let _ = write_tx.send(bytes);

                    // CTRL+C delivers SIGINT to the foreground process group
                    // immediately (verified: the line discipline kills e.g.
                    // `cat /dev/urandom` on the first press). But a flood it
                    // already produced sits buffered in pty_rx and would keep
                    // scrolling for seconds, making the interrupt *look* dead.
                    // Those bytes are the killed process's output — drop the
                    // backlog so the screen stops at once. Only triggers on a
                    // genuine flood; normal output never buffers this deep.
                    if is_interrupt && pty_rx.len() > INTERRUPT_FLUSH_BACKLOG {
                        let mut hit_eof = false;
                        while let Ok(ev) = pty_rx.try_recv() {
                            match ev {
                                PtyEvent::Data(_) => {}
                                PtyEvent::Eof => {
                                    hit_eof = true;
                                    break;
                                }
                            }
                        }
                        if hit_eof {
                            break;
                        }
                    }
                }
                Ok(TabCmd::Resize { cols, rows, cell_width_px, cell_height_px }) => {
                    match &mut backend {
                        #[cfg(not(any(target_os = "ios", target_os = "android")))]
                        Backend::Pty { master, .. } => {
                            let _ = master.resize(PtySize {
                                rows,
                                cols,
                                pixel_width: (cell_width_px as u16).saturating_mul(cols),
                                pixel_height: (cell_height_px as u16).saturating_mul(rows),
                            });
                        }
                        Backend::Ssh { out_tx } => {
                            let _ = out_tx.blocking_send(SshIoCmd::Resize {
                                cols,
                                rows,
                                w_px: (cell_width_px as u32).saturating_mul(cols as u32),
                                h_px: (cell_height_px as u32).saturating_mul(rows as u32),
                            });
                        }
                    }
                    let _ = terminal.resize(cols, rows, cell_width_px, cell_height_px);
                    pending_emit = true;
                }
                Ok(TabCmd::SetWindow(label)) => {
                    owner_window = label;
                    pending_emit = true;
                }
                Ok(TabCmd::Scroll(kind)) => {
                    let sv = match kind {
                        ScrollKind::Top => ScrollViewport::Top,
                        ScrollKind::Bottom => ScrollViewport::Bottom,
                        ScrollKind::LineUp => ScrollViewport::Delta(-1),
                        ScrollKind::LineDown => ScrollViewport::Delta(1),
                        ScrollKind::PageUp => {
                            ScrollViewport::Delta(-(terminal.rows().unwrap_or(1) as isize))
                        }
                        ScrollKind::PageDown => {
                            ScrollViewport::Delta(terminal.rows().unwrap_or(1) as isize)
                        }
                        ScrollKind::Delta(n) => ScrollViewport::Delta(n as isize),
                    };
                    terminal.scroll_viewport(sv);
                    pending_emit = true;
                }
                Ok(TabCmd::Wheel(rows)) => {
                    let alt = terminal
                        .active_screen()
                        .map(|s| s == Screen::Alternate)
                        .unwrap_or(false);
                    let tracking = terminal.is_mouse_tracking().unwrap_or(false);
                    if rows != 0 && alt && !tracking {
                        // Alternate screen, no mouse reporting → drive the app
                        // like the arrow keys do. input.ts sends ESC[A / ESC[B
                        // (no DECCKM handling), so match that exactly — apps like
                        // nano already respond to those.
                        let seq: &[u8] = if rows < 0 { b"\x1b[A" } else { b"\x1b[B" };
                        let count = rows.unsigned_abs().min(WHEEL_ARROW_CAP) as usize;
                        let mut bytes = Vec::with_capacity(seq.len() * count);
                        for _ in 0..count {
                            bytes.extend_from_slice(seq);
                        }
                        terminal.scroll_viewport(ScrollViewport::Bottom);
                        // Reliable blocking send, same path as TabCmd::Write.
                        let _ = write_tx.send(bytes);
                    } else {
                        terminal.scroll_viewport(ScrollViewport::Delta(rows as isize));
                        pending_emit = true;
                    }
                }
                Ok(TabCmd::CopyText { start, end, reply }) => {
                    let cols = terminal.cols().unwrap_or(0);
                    let text = extract_screen_text(&terminal, start, end, cols);
                    let _ = reply.send(text);
                }
                Ok(TabCmd::Shutdown) | Err(_) => {
                    // PTY children are killed + reaped after the loop (all exit
                    // paths share that); only SSH needs an explicit close here.
                    if let Backend::Ssh { out_tx } = &mut backend {
                        let _ = out_tx.blocking_send(SshIoCmd::Close);
                    }
                    break;
                }
            },
            recv(pty_rx) -> msg => match msg {
                Ok(PtyEvent::Data(bytes)) => {
                    terminal.vt_write(&bytes);
                    pending_emit = true;
                }
                Ok(PtyEvent::Eof) | Err(_) => {
                    break;
                }
            },
            default(timeout_tick) => {}
        }

        if pending_emit && last_emit.elapsed() >= debounce {
            generation += 1;
            let theme = config.lock().theme.clone();
            match emit_render(
                &app,
                tab_id,
                &owner_window,
                generation,
                &mut render_state,
                &terminal,
                &mut row_iter,
                &mut cell_iter,
                &theme,
            ) {
                Ok(()) => {
                    emit_count += 1;
                    if emit_count == 1 || emit_count == 10 {
                        eprintln!("[tab {tab_id}] emitted render #{emit_count}");
                    }
                }
                Err(e) => eprintln!("[tab {tab_id}] emit failed: {e:?}"),
            }
            pending_emit = false;
            last_emit = Instant::now();
        }
    }

    // Reap the child on every exit path. kill() is harmless if it already
    // exited; without the wait() the process stays a zombie until app exit.
    // std::process::Child caches the status, so wait() after kill()'s internal
    // try_wait still yields the real exit code.
    let status = match &mut backend {
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        Backend::Pty { child, .. } => {
            let _ = child.kill();
            child.wait().map(|s| s.exit_code() as i32).unwrap_or(0)
        }
        Backend::Ssh { .. } => 0,
    };
    Ok(status)
}

fn rgb_to_u32(c: RgbColor) -> u32 {
    (u32::from(c.r) << 16) | (u32::from(c.g) << 8) | u32::from(c.b)
}

/// Extract the text of an inclusive screen-absolute range `[start, end]` from
/// the full grid (including scrollback), one `\n` per visual row with trailing
/// whitespace trimmed. `start`/`end` are `(col, screen_row)` and must already
/// be ordered (start before end in reading order). Reads each cell via
/// `grid_ref(Point::Screen(..))`, which can address rows above the viewport —
/// that's what lets copy reach scrollback the render snapshot never shipped.
fn extract_screen_text(terminal: &Terminal, start: (u16, u32), end: (u16, u32), cols: u16) -> String {
    if cols == 0 || end.1 < start.1 {
        return String::new();
    }
    let last_col = cols - 1;
    let mut lines: Vec<String> = Vec::with_capacity((end.1 - start.1 + 1) as usize);
    let mut buf = [' '; 32];
    for row in start.1..=end.1 {
        let c0 = if row == start.1 { start.0 } else { 0 };
        let c1 = if row == end.1 { end.0.min(last_col) } else { last_col };
        let mut line = String::new();
        let mut col = c0;
        while col <= c1 {
            let coord = PointCoordinate { x: col, y: row };
            let gr = match terminal.grid_ref(Point::Screen(coord)) {
                Ok(gr) => gr,
                Err(_) => {
                    line.push(' ');
                    col += 1;
                    continue;
                }
            };
            // Skip the trailing spacer that follows a wide cell — its glyph
            // already came from the wide cell itself.
            if matches!(gr.cell().and_then(|c| c.wide()), Ok(CellWide::SpacerTail)) {
                col += 1;
                continue;
            }
            match gr.graphemes(&mut buf) {
                Ok(0) => line.push(' '),
                Ok(n) => line.extend(&buf[..n]),
                Err(libghostty_vt::Error::OutOfSpace { required }) if required > 0 => {
                    let mut big = vec![' '; required];
                    if let Ok(n) = gr.graphemes(&mut big) {
                        line.extend(&big[..n]);
                    } else {
                        line.push(' ');
                    }
                }
                Err(_) => line.push(' '),
            }
            col += 1;
        }
        lines.push(line.trim_end().to_string());
    }
    lines.join("\n")
}

fn resolve_style_color(sc: StyleColor, palette: &[RgbColor; 256]) -> Option<RgbColor> {
    match sc {
        StyleColor::None => None,
        StyleColor::Rgb(c) => Some(c),
        StyleColor::Palette(idx) => Some(palette[idx.0 as usize]),
    }
}

fn parse_hex(s: &str) -> RgbColor {
    let t = s.trim().trim_start_matches('#');
    let bytes = t.as_bytes();
    let (r, g, b) = match bytes.len() {
        6 => {
            let r = u8::from_str_radix(&t[0..2], 16).unwrap_or(0);
            let g = u8::from_str_radix(&t[2..4], 16).unwrap_or(0);
            let b = u8::from_str_radix(&t[4..6], 16).unwrap_or(0);
            (r, g, b)
        }
        3 => {
            let r = u8::from_str_radix(&t[0..1], 16).unwrap_or(0);
            let g = u8::from_str_radix(&t[1..2], 16).unwrap_or(0);
            let b = u8::from_str_radix(&t[2..3], 16).unwrap_or(0);
            (r * 17, g * 17, b * 17)
        }
        _ => (0, 0, 0),
    };
    RgbColor { r, g, b }
}

fn build_themed_colors(
    snapshot_palette: &[RgbColor; 256],
    theme: &Theme,
) -> (RgbColor, RgbColor, [RgbColor; 256]) {
    let mut palette = *snapshot_palette;
    for (i, hex) in theme.palette.iter().enumerate() {
        if i < palette.len() {
            palette[i] = parse_hex(hex);
        }
    }
    (
        parse_hex(&theme.foreground),
        parse_hex(&theme.background),
        palette,
    )
}

#[allow(clippy::too_many_arguments)]
fn emit_render<'a>(
    app: &AppHandle,
    tab_id: u64,
    owner_window: &str,
    generation: u64,
    render_state: &mut RenderState<'a>,
    terminal: &Terminal<'a, 'a>,
    row_iter: &mut RowIterator<'a>,
    cell_iter: &mut CellIterator<'a>,
    theme: &Theme,
) -> AppResult<()> {
    let snapshot = match render_state.update(terminal) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[tab {tab_id}] render_state.update failed: {e:?}");
            return Ok(());
        }
    };

    // Don't early-return on Dirty::Clean: libghostty-vt's dirty flags only
    // track row mutations, NOT cursor moves or title changes. Skipping
    // Clean snapshots leaves the cursor stuck at its last drawn position
    // when the shell emits pure cursor-position escapes after rendering
    // text. The cost of always serializing the current grid is fine — the
    // 8ms debounce caps emit frequency.
    let _ = snapshot.dirty();

    let cols = snapshot.cols().unwrap_or(0);
    let rows = snapshot.rows().unwrap_or(0);
    if cols == 0 || rows == 0 {
        return Ok(());
    }
    let colors = match snapshot.colors() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[tab {tab_id}] snapshot.colors failed: {e:?}");
            return Ok(());
        }
    };
    let (themed_fg, themed_bg, themed_palette) = build_themed_colors(&colors.palette, theme);
    let default_fg = rgb_to_u32(themed_fg);
    let default_bg = rgb_to_u32(themed_bg);

    let cursor = if snapshot.cursor_visible().unwrap_or(false) {
        match snapshot.cursor_viewport() {
            Ok(Some(cv)) => {
                let style_byte = match snapshot.cursor_visual_style() {
                    Ok(CursorVisualStyle::Block) => CURSOR_STYLE_BLOCK,
                    Ok(CursorVisualStyle::Bar) => CURSOR_STYLE_BAR,
                    Ok(CursorVisualStyle::Underline) => CURSOR_STYLE_UNDERLINE,
                    Ok(CursorVisualStyle::BlockHollow) => CURSOR_STYLE_BLOCK_HOLLOW,
                    _ => CURSOR_STYLE_BLOCK,
                };
                Some(CursorWire {
                    x: cv.x,
                    y: cv.y,
                    visible: true,
                    style: style_byte,
                    blinking: snapshot.cursor_blinking().unwrap_or(false),
                })
            }
            _ => None,
        }
    } else {
        None
    };

    let title = terminal.title().unwrap_or("").to_string();

    let mut cells: Vec<CellWire> = Vec::with_capacity(cols as usize * rows as usize);

    let mut row_iteration = match row_iter.update(&snapshot) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[tab {tab_id}] row_iter.update failed: {e:?}");
            return Ok(());
        }
    };
    while let Some(row) = row_iteration.next() {
        let mut emitted = 0u16;
        let mut cell_iteration = match cell_iter.update(row) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[tab {tab_id}] cell_iter.update failed: {e:?}");
                break;
            }
        };
        while let Some(cell) = cell_iteration.next() {
            if emitted >= cols {
                break;
            }
            let codepoint;
            let wide_kind;
            match cell.raw_cell() {
                Ok(raw) => {
                    codepoint = raw.codepoint().unwrap_or(0);
                    wide_kind = raw.wide().unwrap_or(CellWide::Narrow);
                }
                Err(_) => {
                    codepoint = 0;
                    wide_kind = CellWide::Narrow;
                }
            }

            let (style_opt, has_styling) = match cell.style() {
                Ok(s) => (Some(s), true),
                Err(_) => (None, false),
            };

            let mut flags: u8 = 0;
            if has_styling {
                if let Some(s) = style_opt {
                    if s.bold {
                        flags |= FLAG_BOLD;
                    }
                    if s.italic {
                        flags |= FLAG_ITALIC;
                    }
                    if s.faint {
                        flags |= FLAG_FAINT;
                    }
                    if s.inverse {
                        flags |= FLAG_INVERSE;
                    }
                    if s.strikethrough {
                        flags |= FLAG_STRIKETHROUGH;
                    }
                    if !matches!(s.underline, libghostty_vt::style::Underline::None) {
                        flags |= FLAG_UNDERLINE;
                    }
                }
            }
            match wide_kind {
                CellWide::Wide => flags |= FLAG_WIDE,
                CellWide::SpacerTail => flags |= FLAG_SPACER_TAIL,
                _ => {}
            }

            let fg_rgb = cell
                .fg_color()
                .ok()
                .flatten()
                .or_else(|| {
                    style_opt
                        .and_then(|s| resolve_style_color(s.fg_color, &themed_palette))
                })
                .map_or(default_fg, rgb_to_u32);
            let bg_rgb = cell
                .bg_color()
                .ok()
                .flatten()
                .or_else(|| {
                    style_opt
                        .and_then(|s| resolve_style_color(s.bg_color, &themed_palette))
                })
                .map_or(default_bg, rgb_to_u32);

            let (final_fg, final_bg) = if flags & FLAG_INVERSE != 0 {
                (bg_rgb, fg_rgb)
            } else {
                (fg_rgb, bg_rgb)
            };

            cells.push(CellWire {
                ch: codepoint,
                fg: final_fg,
                bg: final_bg,
                flags,
            });
            emitted = emitted.saturating_add(1);
        }
        while emitted < cols {
            cells.push(CellWire {
                ch: 0,
                fg: default_fg,
                bg: default_bg,
                flags: 0,
            });
            emitted = emitted.saturating_add(1);
        }
        row.set_dirty(false).ok();
    }

    snapshot.set_dirty(Dirty::Clean).ok();

    // Selection coordinates on the frontend are screen-absolute (relative to
    // top of scrollback), so we ship the viewport's scrollback offset every
    // frame. `scrollback_total` lets the frontend size the scrollbar thumb.
    // The scrollbar query is documented as "may be expensive" but only when
    // viewport pins are arbitrary; the bottom-anchored common case is cheap,
    // and the 8ms debounce caps frequency.
    let sb = terminal.scrollbar().ok();
    let viewport_top = sb.map(|s| s.offset).unwrap_or(0);
    let scrollback_total = sb.map(|s| s.total).unwrap_or(rows as u64);

    let payload = RenderPayload {
        tab_id,
        cols,
        rows,
        default_fg,
        default_bg,
        cells,
        cursor,
        generation,
        title,
        viewport_top,
        scrollback_total,
    };
    let _ = app.emit_to(
        EventTarget::webview_window(owner_window),
        "terminal:render",
        payload,
    );
    Ok(())
}

pub type SharedRegistry = Arc<TabRegistry>;

fn handle_to_info(h: &TabHandle) -> TabInfo {
    TabInfo {
        id: h.id,
        title: h.host_label.clone().unwrap_or_default(),
        kind: h.kind.as_wire().to_string(),
        host_id: h.host_id,
        host_label: h.host_label.clone(),
        disable_sftp: h.disable_sftp,
        disable_ssh: h.disable_ssh,
    }
}
