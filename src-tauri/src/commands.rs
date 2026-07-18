use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crossbeam_channel::unbounded;

use crate::{
    activate_blank_window, configure_new_window,
    config::{Config, TerminalPrefs, Theme, UiPrefs},
    error::{AppError, AppResult},
    git, localfs,
    protocol::{
        KeyEventWire, LocalDrive, LocalListing, MouseEventWire, SftpEntry, TabInfo,
        WindowBootstrap,
    },
    schedule_refill,
    ssh::{self, SftpConsumers, SharedPool, SshConnectConfig},
    stronghold::{self, StrongholdUnlock},
    tab::{PtyEvent, ScrollKind, SftpReq, SharedRegistry},
    window_pool::WindowMode,
    DbUrl, SharedConfig, SharedPendingHydration, SharedRuntime, SharedWindowCounter,
    SharedWindowPool,
};

#[cfg(target_os = "macos")]
use crate::platform;

#[derive(serde::Deserialize)]
pub struct SpawnArgs {
    pub cols: u16,
    pub rows: u16,
    pub cell_width_px: u32,
    pub cell_height_px: u32,
    /// Optional initial working directory (restoring a saved workspace's
    /// terminal into the folder it was in). Ignored if it no longer exists.
    #[serde(default)]
    pub cwd: Option<String>,
}

#[tauri::command]
pub fn spawn_tab(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, SharedRegistry>,
    config: State<'_, SharedConfig>,
    args: SpawnArgs,
) -> AppResult<u64> {
    // iOS forbids fork/exec for App-Store binaries and Android's
    // sandbox forbids spawning arbitrary executables. The mobile UX is
    // SSH-only; the frontend should hide the "new local tab" button on
    // those targets, but guard here as well so a stray invoke can't
    // crash the app.
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let _ = (app, window, registry, config, args);
        return Err(AppError::Other(
            "local shell tabs are not available on this platform".into(),
        ));
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let (shell, scrollback_lines) = {
            let guard = config.lock();
            (guard.shell.clone(), guard.scrollback_lines)
        };
        registry.spawn(
            app,
            window.label().to_string(),
            args.cols.max(1),
            args.rows.max(1),
            args.cell_width_px.max(1),
            args.cell_height_px.max(1),
            shell,
            scrollback_lines,
            config.inner().clone(),
            args.cwd,
        )
    }
}

#[tauri::command]
pub fn close_tab(registry: State<'_, SharedRegistry>, tab_id: u64) -> AppResult<()> {
    registry.close(tab_id)
}

/// Foreground process of a local tab's PTY, when it isn't the shell itself —
/// the "something is still running here" probe behind the confirm-on-close
/// guard. `None` for idle shells, SSH tabs, unknown tabs and on Windows.
#[tauri::command]
pub fn tab_foreground_process(
    registry: State<'_, SharedRegistry>,
    tab_id: u64,
) -> Option<crate::protocol::ForegroundProcess> {
    registry.foreground_process(tab_id)
}

#[tauri::command]
pub fn write_input(
    registry: State<'_, SharedRegistry>,
    tab_id: u64,
    bytes: Vec<u8>,
) -> AppResult<()> {
    registry.write_input(tab_id, bytes)
}

/// Forward a keyboard event to the tab thread, where libghostty-vt's key
/// encoder turns it into bytes against the terminal's live modes (DECCKM,
/// keypad mode, kitty keyboard protocol flags).
#[tauri::command]
pub fn write_key(
    registry: State<'_, SharedRegistry>,
    tab_id: u64,
    event: KeyEventWire,
) -> AppResult<()> {
    registry.write_key(tab_id, event)
}

/// Paste text into a tab. The tab thread wraps it in bracketed-paste
/// markers when the application enabled DEC mode 2004.
#[tauri::command]
pub fn write_paste(
    registry: State<'_, SharedRegistry>,
    tab_id: u64,
    bytes: Vec<u8>,
) -> AppResult<()> {
    registry.write_paste(tab_id, bytes)
}

#[tauri::command]
pub fn resize_tab(
    registry: State<'_, SharedRegistry>,
    tab_id: u64,
    cols: u16,
    rows: u16,
    cell_width_px: u32,
    cell_height_px: u32,
) -> AppResult<()> {
    registry.resize(
        tab_id,
        cols.max(1),
        rows.max(1),
        cell_width_px.max(1),
        cell_height_px.max(1),
    )
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScrollKindWire {
    Top,
    Bottom,
    LineUp,
    LineDown,
    PageUp,
    PageDown,
    Delta { delta: i32 },
}

impl From<ScrollKindWire> for ScrollKind {
    fn from(w: ScrollKindWire) -> Self {
        match w {
            ScrollKindWire::Top => ScrollKind::Top,
            ScrollKindWire::Bottom => ScrollKind::Bottom,
            ScrollKindWire::LineUp => ScrollKind::LineUp,
            ScrollKindWire::LineDown => ScrollKind::LineDown,
            ScrollKindWire::PageUp => ScrollKind::PageUp,
            ScrollKindWire::PageDown => ScrollKind::PageDown,
            ScrollKindWire::Delta { delta } => ScrollKind::Delta(delta),
        }
    }
}

#[tauri::command]
pub fn scroll_tab(
    registry: State<'_, SharedRegistry>,
    tab_id: u64,
    kind: ScrollKindWire,
) -> AppResult<()> {
    registry.scroll(tab_id, kind.into())
}

/// Physical mouse-wheel notch in rows (negative = up) at the pointer cell
/// `(col, row)` (viewport-relative). Routed on the tab thread: button-4/5 mouse
/// reports when the app has mouse tracking on, else arrow keys for an
/// alternate-screen app, else a viewport scroll. Separate from `scroll_tab` so
/// the scrollbar/keyboard/selection paths keep pure viewport-scroll semantics.
#[tauri::command]
pub fn wheel_scroll(
    registry: State<'_, SharedRegistry>,
    tab_id: u64,
    rows: i32,
    col: u16,
    row: u16,
) -> AppResult<()> {
    registry.wheel_scroll(tab_id, rows, col, row)
}

/// Forward a mouse press/release/motion to a tab. Encoded on the tab thread
/// against the app's live tracking mode + output format; a no-op (no bytes) when
/// the app isn't reporting that event. The frontend only calls this when an app
/// has mouse tracking on and Shift isn't held (Shift = local selection).
#[tauri::command]
pub fn write_mouse(
    registry: State<'_, SharedRegistry>,
    tab_id: u64,
    ev: MouseEventWire,
) -> AppResult<()> {
    registry.write_mouse(tab_id, ev)
}

/// Returns the selected text for a screen-absolute coordinate range so the
/// frontend can copy selections that extend into scrollback (which the render
/// snapshot doesn't include). Coordinates must be pre-ordered (start before
/// end in reading order); `*_row` is relative to the top of the scrollback.
#[tauri::command]
pub fn copy_selection_text(
    registry: State<'_, SharedRegistry>,
    tab_id: u64,
    start_col: u16,
    start_row: u32,
    end_col: u16,
    end_row: u32,
) -> AppResult<String> {
    registry.copy_text(tab_id, (start_col, start_row), (end_col, end_row))
}

#[tauri::command]
pub fn list_tabs(registry: State<'_, SharedRegistry>) -> Vec<TabInfo> {
    registry.list()
}

#[tauri::command]
pub fn get_config(config: State<'_, SharedConfig>) -> Config {
    config.lock().clone()
}

/// Built-in defaults, for the settings pane's reset-to-defaults actions.
#[tauri::command]
pub fn default_terminal_config() -> Config {
    Config::default()
}

#[tauri::command]
pub fn set_theme(config: State<'_, SharedConfig>, theme: Theme) -> AppResult<()> {
    let mut guard = config.lock();
    guard.theme = theme;
    guard.save()
}

#[tauri::command]
pub fn set_ui_prefs(config: State<'_, SharedConfig>, ui: UiPrefs) -> AppResult<()> {
    let mut guard = config.lock();
    guard.ui = ui;
    guard.save()
}

/// Persist keyboard-shortcut overrides (action id → serialized chord). The
/// frontend sends only the actions that differ from their defaults; this
/// replaces the whole table.
#[tauri::command]
pub fn set_keybindings(
    config: State<'_, SharedConfig>,
    keybindings: std::collections::BTreeMap<String, String>,
) -> AppResult<()> {
    let mut guard = config.lock();
    guard.keybindings = keybindings;
    guard.save()
}

/// Save the terminal-core settings. `shell` / `login_shell` /
/// `scrollback_lines` are read from the live config when a tab spawns, so
/// they apply to new tabs immediately; the font fields are consumed by the
/// frontend renderer at startup and need a restart.
#[tauri::command]
pub fn set_terminal_prefs(config: State<'_, SharedConfig>, prefs: TerminalPrefs) -> AppResult<()> {
    let mut guard = config.lock();
    guard.font_family = prefs.font_family;
    guard.font_size = prefs.font_size;
    guard.line_height = prefs.line_height;
    guard.shell = prefs.shell;
    guard.login_shell = prefs.login_shell;
    guard.scrollback_lines = prefs.scrollback_lines;
    guard.save()
}

#[tauri::command]
pub fn forget_tab(registry: State<'_, SharedRegistry>, tab_id: u64) {
    registry.forget(tab_id);
}

/// Forwards a frontend `console.*` call to the Tauri dev console. The
/// frontend patches `console.log/info/warn/error/debug` to invoke this
/// in addition to the original (so devtools still shows the message).
#[tauri::command]
pub fn frontend_log(window: WebviewWindow, level: String, message: String) {
    let label = window.label();
    let lvl = level.to_uppercase();
    // `eprintln!` so logs aren't interleaved with tauri's own stdout
    // pipes and so they remain visible when stdout is being captured.
    eprintln!("[fe:{label}] [{lvl}] {message}");
}

#[derive(serde::Deserialize)]
pub struct TearOffArgs {
    pub tab_id: u64,
    pub screen_x: f64,
    pub screen_y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(serde::Deserialize)]
pub struct TearOffWindowArgs {
    pub screen_x: f64,
    pub screen_y: f64,
    pub width: f64,
    pub height: f64,
}

/// Pop a `Ready` reserve (resizing/repositioning/showing it) or build a
/// fresh window at the given screen geometry — the shared "give me a
/// window for this tear-off drop" mechanics behind `tear_off_tab` (which
/// also attaches one backend tab in the same round-trip) and
/// `tear_off_window` (whole-workspace moves, which need the label before
/// they know every backend id to attach — a multi-pane workspace has no
/// single "the" tab to hand `tear_off_tab`). Returns the label and whether
/// it came from an already-booted reserve (its frontend listeners are
/// live, so an event can be emitted to it immediately) or a freshly built
/// window (still cold-starting — only the registry-backed
/// `list_tabs_for_window`/`bootstrap_window` discovery path reaches it
/// reliably, not a live emit).
fn pop_or_build_tear_off_window(
    app: &AppHandle,
    registry: &SharedRegistry,
    counter: &SharedWindowCounter,
    pool: &SharedWindowPool,
    screen_x: f64,
    screen_y: f64,
    width: f64,
    height: f64,
) -> AppResult<(String, bool)> {
    // Position so the drop point lands at the window's center rather
    // than its top-left, matching how a torn-off tab "becomes" the new
    // window under the cursor.
    let pos_x = screen_x - width / 2.0;
    let pos_y = screen_y - height / 2.0;

    if let Some(label) = pool.pop_for_tear_off() {
        if let Some(window) = app.get_webview_window(&label) {
            // Defensive: a reserve should have no tabs in the registry.
            // If something accidentally attached one earlier (e.g., an
            // older build's hit-test that didn't skip hidden reserves),
            // kill it before adopting the torn-off tab(s) so the activated
            // window shows just what the caller attaches. The
            // terminal:exit event removes any matching pill from the
            // reserve's frontend state.
            for existing_id in registry.tabs_in_window(&label) {
                let _ = registry.close(existing_id);
            }
            let _ = window.set_size(LogicalSize::new(width, height));
            let _ = window.set_position(LogicalPosition::new(pos_x, pos_y));
            let _ = window.show();
            let _ = window.set_focus();
            // Defer the replacement build off the command thread.
            // Otherwise `WebviewWindowBuilder::build` runs back-to-back
            // with the show()/focus() we just issued, and on macOS the
            // new reserve's NSWindow init competes for the same main
            // runloop that's trying to actually paint the window we
            // just made visible.
            schedule_refill(app);
            return Ok((label, true));
        }
        pool.note_destroyed(&label);
    }

    let label = format!("window-{}", counter.next());
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title("Prmpt")
        .inner_size(width, height)
        .position(pos_x, pos_y)
        // Dark terminal-colored frame during the webview cold-start
        // instead of a white flash after the drop.
        .background_color(tauri::window::Color(0x1e, 0x1e, 0x2e, 0xff))
        // Let HTML5 drag-and-drop work inside the webview (tab → terminal
        // workspace drops). Tauri's OS-level drag-drop handler otherwise
        // swallows dragover/drop events; tab tear-off only needs dragend.
        .disable_drag_drop_handler();
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(platform::title_bar_style())
        .hidden_title(platform::hidden_title());
    #[cfg(target_os = "windows")]
    let builder = builder.decorations(false);
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let builder = builder.focused(true);
    let window = builder
        .visible(true)
        .build()
        .map_err(|e| AppError::Other(format!("build window: {e}")))?;

    configure_new_window(&window);

    // Top the pool back up after spending a fallback build slot too —
    // building the fresh window already happened, but the pool itself
    // was empty when we entered. Deferred for the same main-thread
    // reasons as the fast path above.
    schedule_refill(app);

    Ok((label, false))
}

#[tauri::command]
pub fn tear_off_tab(
    app: AppHandle,
    registry: State<'_, SharedRegistry>,
    counter: State<'_, SharedWindowCounter>,
    pending: State<'_, SharedPendingHydration>,
    pool: State<'_, SharedWindowPool>,
    args: TearOffArgs,
) -> AppResult<String> {
    let (label, from_reserve) = pop_or_build_tear_off_window(
        &app,
        &registry,
        &counter,
        &pool,
        args.screen_x,
        args.screen_y,
        args.width,
        args.height,
    )?;

    registry.set_window(args.tab_id, label.clone())?;

    if from_reserve {
        // Emit the same attach event tabs use when dragged into an
        // existing window. The reserve's frontend already finished
        // bootstrap (otherwise pop_for_tear_off would have returned
        // None), so its onTabAttached listener is installed. The
        // frontend dedups by tab id, so even if bootstrap_window also
        // returns this tab via tabs_in_window, the second add is a
        // no-op.
        if let Some(info) = registry.info(args.tab_id) {
            let _ = app.emit_to(
                EventTarget::webview_window(&label),
                "window:tab_attached",
                info,
            );
        }
    } else {
        // Stash the hydration list so the frontend's first call to
        // list_tabs_for_window (after the fresh webview boots) sees this
        // tab — a live attach event would arrive before its listeners
        // are installed and be lost.
        pending
            .0
            .lock()
            .entry(label.clone())
            .or_default()
            .push(args.tab_id);
    }

    Ok(label)
}

/// Label-only counterpart of `tear_off_tab`: creates (or pops a reserve
/// for) a window positioned/sized for a tear-off drop, without attaching
/// any tab to it. Used by whole-workspace cross-window moves
/// (`src/state/drag.ts::moveWorkspaceOut`) — a multi-pane workspace has no
/// single backend id to hand `tear_off_tab`, so the frontend needs the
/// target label up front and then attaches each pane's backend id itself
/// via `attach_tab`.
#[tauri::command]
pub fn tear_off_window(
    app: AppHandle,
    registry: State<'_, SharedRegistry>,
    counter: State<'_, SharedWindowCounter>,
    pool: State<'_, SharedWindowPool>,
    args: TearOffWindowArgs,
) -> AppResult<String> {
    let (label, _from_reserve) = pop_or_build_tear_off_window(
        &app,
        &registry,
        &counter,
        &pool,
        args.screen_x,
        args.screen_y,
        args.width,
        args.height,
    )?;
    Ok(label)
}

/// Cmd+N entry point. Pops a Ready reserve or falls back to building a
/// fresh blank window — same shape as the macOS dock-click handler.
#[tauri::command]
pub fn open_new_window(app: AppHandle) -> AppResult<()> {
    activate_blank_window(&app, None);
    Ok(())
}

/// Like `open_new_window`, but the surfaced window opens a frontend panel
/// (file browser / git) instead of a terminal. Entry point for dragging a
/// + menu option out of the window (`desc`/`title` absent — a fresh panel)
/// and for tearing a panel pane off into its own window (`desc`/`title`
/// carry the pane's live seeds + title, opaque to the backend). `kind` is a
/// `PanelKind` ("files"/"git").
#[tauri::command]
pub fn open_panel_window(
    app: AppHandle,
    kind: String,
    desc: Option<serde_json::Value>,
    title: Option<String>,
) -> AppResult<()> {
    activate_blank_window(&app, Some(crate::PanelSpawn { kind, desc, title }));
    Ok(())
}

/// Frontend bootstrap query. Tells the caller whether to behave as a
/// pre-warmed reserve (sit idle until activation) or as a normal window
/// (hydrate listed tabs or spawn a fresh one). Returning Reserve here is
/// also what flips the reserve from `Building` to `Ready` — the very fact
/// that the frontend got far enough to invoke this command means its
/// listeners are installed and a future pop won't lose events.
#[tauri::command]
pub fn bootstrap_window(
    registry: State<'_, SharedRegistry>,
    pending: State<'_, SharedPendingHydration>,
    pool: State<'_, SharedWindowPool>,
    label: String,
) -> WindowBootstrap {
    use std::collections::BTreeSet;

    match pool.mode_for(&label) {
        WindowMode::Reserve => {
            pool.mark_ready(&label);
            WindowBootstrap {
                mode: WindowMode::Reserve,
                tabs: Vec::new(),
            }
        }
        WindowMode::Normal => {
            let drained = pending.0.lock().remove(&label).unwrap_or_default();
            let mut ids: BTreeSet<u64> = drained.into_iter().collect();
            for id in registry.tabs_in_window(&label) {
                ids.insert(id);
            }
            let tabs = ids
                .into_iter()
                .filter_map(|id| registry.info(id))
                .collect();
            WindowBootstrap {
                mode: WindowMode::Normal,
                tabs,
            }
        }
    }
}

#[tauri::command]
pub fn attach_tab(
    app: AppHandle,
    registry: State<'_, SharedRegistry>,
    pool: State<'_, SharedWindowPool>,
    tab_id: u64,
    target_label: String,
) -> AppResult<()> {
    // Belt to window_at_screen_point's suspenders: refuse to attach into a
    // reserve. If a reserve ever leaked past the hit-test (older client
    // builds, races, custom callers), it would silently pile tabs onto a
    // hidden window — visible only after a future tear-off pops it.
    if pool.mode_for(&target_label) == WindowMode::Reserve {
        return Err(AppError::Other(format!(
            "cannot attach to reserve window {target_label}"
        )));
    }
    registry.set_window(tab_id, target_label.clone())?;
    let info = registry
        .info(tab_id)
        .ok_or(AppError::UnknownTab(tab_id))?;
    app.emit_to(
        EventTarget::webview_window(&target_label),
        "window:tab_attached",
        info,
    )
    .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn list_tabs_for_window(
    registry: State<'_, SharedRegistry>,
    pending: State<'_, SharedPendingHydration>,
    label: String,
) -> Vec<TabInfo> {
    use std::collections::BTreeSet;

    let drained = pending.0.lock().remove(&label).unwrap_or_default();
    let mut ids: BTreeSet<u64> = drained.into_iter().collect();
    for id in registry.tabs_in_window(&label) {
        ids.insert(id);
    }
    ids.into_iter()
        .filter_map(|id| registry.info(id))
        .collect()
}

#[tauri::command]
pub fn window_at_screen_point(
    app: AppHandle,
    pool: State<'_, SharedWindowPool>,
    x: f64,
    y: f64,
    exclude: String,
) -> Option<String> {
    // Hit-test in logical (CSS) coordinates; both the input from the
    // frontend's pointer events and the values we derive here are
    // logical pixels.
    for (label, window) in app.webview_windows() {
        if label == exclude {
            continue;
        }
        // Reserves are hidden but still have a position/size on macOS (at
        // the OS-default location after build). Hitting one here routes a
        // tear-off into `attach_tab`, which silently adopts the tab into
        // the still-hidden reserve — the user sees the new window appear
        // empty later (when the reserve is activated for a real tear-off)
        // or with extra phantom tabs. Skip via the pool first (definitive,
        // unlike `is_visible` which can briefly misreport on a freshly
        // built hidden window) and is_visible second.
        if pool.mode_for(&label) == WindowMode::Reserve {
            continue;
        }
        if !window.is_visible().unwrap_or(false) {
            continue;
        }
        let scale = window.scale_factor().unwrap_or(1.0);
        let pos = match window.outer_position() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let size = match window.outer_size() {
            Ok(s) => s,
            Err(_) => continue,
        };
        let logical_pos: LogicalPosition<f64> = pos.to_logical(scale);
        let logical_size: LogicalSize<f64> = size.to_logical(scale);
        let left = logical_pos.x;
        let top = logical_pos.y;
        let right = left + logical_size.width;
        let bottom = top + logical_size.height;
        if x >= left && x <= right && y >= top && y <= bottom {
            return Some(label);
        }
    }
    None
}

/// One attachable window for a cross-window tab drag: its outer bounds (for
/// hit-testing the cursor) and the top-left of its *content* (webview client
/// area), all in logical screen coordinates. Subtracting the content origin
/// from a screen point yields the target webview's client coordinates — what
/// its drop-preview code (tab-bar hit test, `resolveDropAt`) works in.
#[derive(serde::Serialize)]
pub struct DragTargetInfo {
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub content_x: f64,
    pub content_y: f64,
}

/// Every window a tab drag could hover/drop onto, ordered most-recently-
/// focused first (`FOCUS_ORDER` — the closest thing to z-order Tauri gives
/// us, so the frontend's first rect hit is the window the user actually
/// sees under the cursor when windows overlap). Fetched once at drag start;
/// the same reserve/visibility filters as `window_at_screen_point` apply.
#[tauri::command]
pub fn window_drag_targets(
    app: AppHandle,
    pool: State<'_, SharedWindowPool>,
    exclude: String,
) -> Vec<DragTargetInfo> {
    let order = crate::FOCUS_ORDER.lock().clone();
    let rank =
        |label: &str| order.iter().position(|l| l == label).unwrap_or(usize::MAX);
    let mut out: Vec<DragTargetInfo> = Vec::new();
    for (label, window) in app.webview_windows() {
        if label == exclude {
            continue;
        }
        if pool.mode_for(&label) == WindowMode::Reserve {
            continue;
        }
        if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
            continue;
        }
        let scale = window.scale_factor().unwrap_or(1.0);
        let (Ok(pos), Ok(size), Ok(content)) = (
            window.outer_position(),
            window.outer_size(),
            window.inner_position(),
        ) else {
            continue;
        };
        let pos: LogicalPosition<f64> = pos.to_logical(scale);
        let size: LogicalSize<f64> = size.to_logical(scale);
        let content: LogicalPosition<f64> = content.to_logical(scale);
        out.push(DragTargetInfo {
            label,
            x: pos.x,
            y: pos.y,
            w: size.width,
            h: size.height,
            content_x: content.x,
            content_y: content.y,
        });
    }
    out.sort_by_key(|t| rank(&t.label));
    out
}

// ---------- SSH unlock + connect ----------

/// Return the snapshot location + quarantine flag for the frontend.
/// The `was_quarantined` field is the only piece the frontend actually
/// uses (to mark previously-saved hosts/keys broken when the boot key
/// was regenerated); the path and password fields are vestigial from
/// when the JS-side stronghold plugin owned the unlock and are kept
/// for the serialized shape only — secret CRUD goes through
/// `secret_get`/`secret_set`/`secret_remove` now.
#[tauri::command]
pub fn get_stronghold_unlock() -> AppResult<StrongholdUnlock> {
    stronghold::prepare_unlock_cached()
}

/// URL the frontend should pass to `Database.load(...)`. Resolved
/// once at startup (see `lib.rs::run`) so JS and Rust agree even
/// when the path is an absolute filesystem path.
#[tauri::command]
pub fn get_db_url(url: State<'_, DbUrl>) -> String {
    url.0.clone()
}

#[derive(serde::Deserialize)]
pub struct SshConnectArgs {
    pub config: SshConnectConfig,
    pub cols: u16,
    pub rows: u16,
    pub cell_width_px: u32,
    pub cell_height_px: u32,
}

/// Open a terminal tab backed by a pooled SSH shell channel. The frontend
/// assembles the `SshConnectConfig` from the SQL plugin (host row + port
/// forwards) and the Stronghold plugin (decrypted secrets) before invoking
/// this. The shell is a *consumer* of the host's shared connection; the file
/// browser acquires its own SFTP consumer separately (`sftp_acquire`).
#[tauri::command]
pub fn connect_ssh_host(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, SharedRegistry>,
    pool: State<'_, SharedPool>,
    config: State<'_, SharedConfig>,
    args: SshConnectArgs,
) -> AppResult<u64> {
    let scrollback = config.lock().scrollback_lines;
    let cols = args.cols.max(1);
    let rows = args.rows.max(1);
    let host_id = args.config.host_id;
    let host_label = args.config.label.clone();
    let disable_sftp = args.config.disable_sftp;
    let disable_ssh = args.config.disable_ssh;

    let id = registry.next_tab_id();
    let (pty_tx, pty_rx) = unbounded::<PtyEvent>();
    let out_tx = pool.acquire_shell(&app, args.config, pty_tx, cols, rows);

    registry.start_ssh_tab(
        id,
        app,
        window.label().to_string(),
        host_id,
        host_label,
        cols,
        rows,
        scrollback,
        config.inner().clone(),
        pty_rx,
        out_tx,
        disable_sftp,
        disable_ssh,
    )?;

    let _ = args.cell_width_px;
    let _ = args.cell_height_px;
    Ok(id)
}

/// Acquire an SFTP consumer for a host's pooled connection (the file browser's
/// own channel, independent of any terminal). Returns the consumer id the
/// frontend routes `sftp_*` calls by, and releases via `sftp_release`.
#[tauri::command]
pub fn sftp_acquire(
    app: AppHandle,
    window: WebviewWindow,
    pool: State<'_, SharedPool>,
    consumers: State<'_, SftpConsumers>,
    config: SshConnectConfig,
) -> AppResult<u64> {
    Ok(pool.acquire_sftp(&app, window.label().to_string(), config, consumers.inner()))
}

/// Release a previously-acquired SFTP consumer. Drops the file browser's
/// channel and, if it was the host connection's last consumer, the connection.
#[tauri::command]
pub fn sftp_release(
    pool: State<'_, SharedPool>,
    consumers: State<'_, SftpConsumers>,
    consumer_id: u64,
) -> AppResult<()> {
    if let Some(handle) = consumers.lock().remove(&consumer_id) {
        pool.release_conn(&handle.conn, consumer_id);
    }
    Ok(())
}

/// Resolve a pending first-connect host-key prompt. The pooled connection's
/// handshake for `host_id` is parked in `check_server_key` until this delivers
/// the user's verdict; rejecting (or never answering) aborts the connection
/// before any credentials are sent.
#[tauri::command]
pub fn ssh_confirm_host_key(
    prompts: State<'_, ssh::HostKeyPrompts>,
    host_id: i64,
    accept: bool,
) -> AppResult<()> {
    if let Some(tx) = prompts.lock().remove(&host_id) {
        let _ = tx.send(accept);
    }
    Ok(())
}

// ---------- SFTP file browser ----------
//
// Each command routes a request to one SFTP *consumer*'s service task (which
// owns the `SftpSession` on the SSH runtime) via that consumer's channel and
// awaits a oneshot reply — the handler never touches russh/sftp types
// directly. `tab_id` is the SFTP consumer id from `sftp_acquire`. Local
// filesystem paths arrive as strings from the native dialog plugin.

/// Clone an SFTP consumer's request sender, or a clean "not available" error
/// when the consumer is unknown (released / never acquired).
fn sftp_sender(
    consumers: &State<'_, SftpConsumers>,
    consumer_id: u64,
) -> AppResult<tokio::sync::mpsc::Sender<SftpReq>> {
    consumers
        .lock()
        .get(&consumer_id)
        .map(|h| h.sftp_tx.clone())
        .ok_or_else(|| AppError::Ssh("SFTP is not available on this connection".into()))
}

/// Send one request to the consumer's SFTP service and await its reply.
async fn sftp_call<T>(
    tx: tokio::sync::mpsc::Sender<SftpReq>,
    build: impl FnOnce(tokio::sync::oneshot::Sender<AppResult<T>>) -> SftpReq,
) -> AppResult<T> {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    tx.send(build(reply_tx))
        .await
        .map_err(|_| AppError::Ssh("SFTP channel closed".into()))?;
    match reply_rx.await {
        Ok(inner) => inner,
        Err(_) => Err(AppError::Ssh("SFTP request dropped".into())),
    }
}

#[tauri::command]
pub async fn sftp_list_dir(
    consumers: State<'_, SftpConsumers>,
    tab_id: u64,
    path: String,
) -> AppResult<Vec<SftpEntry>> {
    let tx = sftp_sender(&consumers, tab_id)?;
    sftp_call(tx, |reply| SftpReq::List { path, reply }).await
}

#[tauri::command]
pub async fn sftp_realpath(
    consumers: State<'_, SftpConsumers>,
    tab_id: u64,
    path: String,
) -> AppResult<String> {
    let tx = sftp_sender(&consumers, tab_id)?;
    sftp_call(tx, |reply| SftpReq::Realpath { path, reply }).await
}

#[tauri::command]
pub async fn sftp_stat(
    consumers: State<'_, SftpConsumers>,
    tab_id: u64,
    path: String,
) -> AppResult<SftpEntry> {
    let tx = sftp_sender(&consumers, tab_id)?;
    sftp_call(tx, |reply| SftpReq::Stat { path, reply }).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    consumers: State<'_, SftpConsumers>,
    tab_id: u64,
    path: String,
) -> AppResult<()> {
    let tx = sftp_sender(&consumers, tab_id)?;
    sftp_call(tx, |reply| SftpReq::Mkdir { path, reply }).await
}

#[tauri::command]
pub async fn sftp_rename(
    consumers: State<'_, SftpConsumers>,
    tab_id: u64,
    from: String,
    to: String,
) -> AppResult<()> {
    let tx = sftp_sender(&consumers, tab_id)?;
    sftp_call(tx, |reply| SftpReq::Rename { from, to, reply }).await
}

#[tauri::command]
pub async fn sftp_remove(
    consumers: State<'_, SftpConsumers>,
    tab_id: u64,
    path: String,
    is_dir: bool,
    transfer_id: u64,
) -> AppResult<()> {
    let tx = sftp_sender(&consumers, tab_id)?;
    sftp_call(tx, |reply| SftpReq::Remove {
        path,
        is_dir,
        transfer_id,
        reply,
    })
    .await
}

#[tauri::command]
pub async fn sftp_download(
    consumers: State<'_, SftpConsumers>,
    tab_id: u64,
    remote: String,
    local: String,
    transfer_id: u64,
) -> AppResult<()> {
    let tx = sftp_sender(&consumers, tab_id)?;
    sftp_call(tx, |reply| SftpReq::Download {
        remote,
        local: std::path::PathBuf::from(local),
        transfer_id,
        reply,
    })
    .await
}

#[tauri::command]
pub async fn sftp_upload(
    consumers: State<'_, SftpConsumers>,
    tab_id: u64,
    local: String,
    remote: String,
    transfer_id: u64,
) -> AppResult<()> {
    let tx = sftp_sender(&consumers, tab_id)?;
    sftp_call(tx, |reply| SftpReq::Upload {
        local: std::path::PathBuf::from(local),
        remote,
        transfer_id,
        reply,
    })
    .await
}

/// Cross-connection copy: stream a remote file or directory tree from one SFTP
/// consumer's session straight to another's (relayed through this process).
/// Progress lands on the destination consumer via `sftp:transfer_progress`.
/// `src_tab`/`dst_tab` are SFTP consumer ids.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn sftp_relay(
    app: AppHandle,
    window: WebviewWindow,
    runtime: State<'_, SharedRuntime>,
    consumers: State<'_, SftpConsumers>,
    src_tab: u64,
    src_path: String,
    dst_tab: u64,
    dst_path: String,
    transfer_id: u64,
) -> AppResult<()> {
    let consumers = consumers.inner().clone();
    let window = window.label().to_string();
    // Run on the SSH runtime, where both consumers' tasks live.
    let (tx, rx) = tokio::sync::oneshot::channel();
    runtime.spawn(async move {
        let r = ssh::relay(
            consumers, app, window, src_tab, src_path, dst_tab, dst_path, transfer_id,
        )
        .await;
        let _ = tx.send(r);
    });
    match rx.await {
        Ok(r) => r,
        Err(_) => Err(AppError::Ssh("relay task dropped".into())),
    }
}

// ---------- Local file browser ----------
//
// Thin wrappers over `crate::localfs`. These are synchronous commands on
// purpose: Tauri runs non-`async` handlers on a worker thread, so the blocking
// `std::fs` calls don't stall the async runtime.

#[tauri::command]
pub fn local_home_dir() -> AppResult<String> {
    localfs::home()
}

#[tauri::command]
pub fn list_local_dir(path: String) -> AppResult<LocalListing> {
    localfs::list_dir(&path)
}

#[tauri::command]
pub fn local_drives() -> Vec<LocalDrive> {
    localfs::list_drives()
}

#[tauri::command]
pub fn local_mkdir(path: String) -> AppResult<()> {
    localfs::mkdir(&path)
}

#[tauri::command]
pub fn local_rename(from: String, to: String) -> AppResult<()> {
    localfs::rename(&from, &to)
}

#[tauri::command]
pub fn local_remove(path: String, is_dir: bool) -> AppResult<()> {
    localfs::remove(&path, is_dir)
}

#[tauri::command]
pub fn local_reveal(path: String) -> AppResult<()> {
    localfs::reveal(&path)
}

#[tauri::command]
pub fn local_open(path: String) -> AppResult<()> {
    localfs::open(&path)
}

// ---------- Git panel ----------
//
// Thin wrappers over `crate::git`. Synchronous on purpose, same as the local
// file browser above: shelling out to git blocks, and non-`async` handlers
// run on a worker thread instead of stalling the async runtime.

/// Working directory of a local tab's shell, so the git panel and
/// saved-workspace snapshots follow `cd`. Prefers the shell's own OSC 7 /
/// OSC 9;9 report (shell integration), else queries the OS for the shell
/// process's cwd — exact on macOS/Linux; on Windows the PEB read is exact
/// for cmd.exe but stuck at the spawn directory for pwsh (which never
/// updates its process cwd). `None` for SSH tabs and dead shells — callers
/// fall back to the file browser's directory.
#[tauri::command]
pub fn terminal_cwd(registry: State<'_, SharedRegistry>, tab_id: u64) -> Option<String> {
    registry.local_cwd(tab_id)
}

#[tauri::command]
pub fn git_status(dir: String) -> AppResult<crate::protocol::GitRepoStatus> {
    git::status(&dir)
}

#[tauri::command]
pub fn git_stage(repo: String, paths: Vec<String>) -> AppResult<()> {
    git::stage(&repo, &paths)
}

#[tauri::command]
pub fn git_unstage(repo: String, paths: Vec<String>) -> AppResult<()> {
    git::unstage(&repo, &paths)
}

#[tauri::command]
pub fn git_commit_changes(repo: String, message: String) -> AppResult<String> {
    git::commit(&repo, &message)
}

#[tauri::command]
pub fn git_diff_file(
    repo: String,
    path: String,
    staged: bool,
    untracked: bool,
) -> AppResult<String> {
    git::diff_file(&repo, &path, staged, untracked)
}

#[tauri::command]
pub fn git_branches(repo: String) -> AppResult<Vec<crate::protocol::GitBranch>> {
    git::branches(&repo)
}

#[tauri::command]
pub fn git_switch_branch(repo: String, name: String) -> AppResult<()> {
    git::switch_branch(&repo, &name)
}

#[tauri::command]
pub fn git_create_branch(repo: String, name: String) -> AppResult<()> {
    git::create_branch(&repo, &name)
}

#[tauri::command]
pub fn git_log(repo: String, limit: u32) -> AppResult<Vec<crate::protocol::GitCommit>> {
    git::log(&repo, limit)
}

#[derive(serde::Serialize)]
pub struct SshKeyInfo {
    /// True if the key text parsed (with or without a passphrase being needed).
    pub valid: bool,
    /// True iff the key requires a passphrase to decode.
    pub encrypted: bool,
    /// Parser error string when `valid` is false. None otherwise.
    pub error: Option<String>,
}

/// Inspects a PEM/OpenSSH-formatted private key without storing it. Used by
/// the key add/edit dialog to surface a "password-protected" note, and by
/// the connect flow to decide whether to prompt for a passphrase.
#[tauri::command]
pub fn inspect_ssh_key(private_key: String) -> SshKeyInfo {
    match russh::keys::decode_secret_key(&private_key, None) {
        Ok(_) => SshKeyInfo {
            valid: true,
            encrypted: false,
            error: None,
        },
        Err(russh::keys::Error::KeyIsEncrypted) => SshKeyInfo {
            valid: true,
            encrypted: true,
            error: None,
        },
        Err(e) => SshKeyInfo {
            valid: false,
            encrypted: false,
            error: Some(e.to_string()),
        },
    }
}

// --- Full Disk Access (macOS) -------------------------------------------
//
// macOS gates a terminal's ability to read protected locations (and to
// let tools it spawns do so) behind the user-granted Full Disk Access
// TCC permission. There is no API to request it; the app can only detect
// the state and deep-link the user to the right Settings pane. The
// frontend shows a one-time explainer on first run when this is false.

/// True if we can read a TCC-protected path — the practical signal that
/// Full Disk Access is granted. The per-user TCC database always exists
/// and opening it for read returns `EPERM` without FDA, `Ok` with it.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn full_disk_access_granted() -> bool {
    let Some(home) = platform::home_dir() else {
        return false;
    };
    let tcc = home.join("Library/Application Support/com.apple.TCC/TCC.db");
    std::fs::File::open(tcc).is_ok()
}

/// Opens System Settings straight to Privacy & Security → Full Disk
/// Access so the user can add Prmpt.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn open_full_disk_access_settings() -> AppResult<()> {
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        .spawn()
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(())
}

// Non-macOS: no such permission model. Report "granted" so the frontend
// explainer never shows, and make the opener a clean no-op so the UI can
// call these commands unconditionally.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn full_disk_access_granted() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn open_full_disk_access_settings() -> AppResult<()> {
    Ok(())
}

/// Read a value from the Rust-owned Stronghold store. Returns `None`
/// if the key isn't set. First call (process-wide) lazily loads the
/// snapshot — that's where scrypt runs, once per process regardless
/// of how many windows are open.
#[tauri::command]
pub async fn secret_get(
    store: tauri::State<'_, crate::secret_store::SecretStore>,
    key: String,
) -> AppResult<Option<Vec<u8>>> {
    store.get(&key).await
}

/// Store a value under `key`. Commits the snapshot to disk.
#[tauri::command]
pub async fn secret_set(
    store: tauri::State<'_, crate::secret_store::SecretStore>,
    key: String,
    value: Vec<u8>,
) -> AppResult<()> {
    store.set(&key, value).await
}

/// Remove a key from the store. Commits the snapshot to disk.
#[tauri::command]
pub async fn secret_remove(
    store: tauri::State<'_, crate::secret_store::SecretStore>,
    key: String,
) -> AppResult<()> {
    store.remove(&key).await
}

/// Called by the frontend right before it spawns the platform installer
/// for an auto-update. Sets `SHUTTING_DOWN` so the per-window Destroyed
/// handler stops refilling the reserve pool, then closes every OS-level
/// webview except the caller (which is still driving the install). The
/// caller exits / relaunches itself once `install()` returns.
#[tauri::command]
pub fn prepare_for_update(app: AppHandle, current_label: String) {
    crate::SHUTTING_DOWN.store(true, std::sync::atomic::Ordering::SeqCst);
    for (label, window) in app.webview_windows() {
        if label == current_label {
            continue;
        }
        // destroy(), not close(): the frontend's onCloseRequested listener
        // (confirm-on-close guard) intercepts close() and could park update
        // teardown behind a confirm dialog in a background window. The user
        // already confirmed the update; tear the window down unconditionally.
        let _ = window.destroy();
    }
}
