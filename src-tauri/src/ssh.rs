//! SSH session task: bridges russh (async, tokio) with the per-tab sync
//! libghostty-vt loop via crossbeam channels + a tokio mpsc.
//!
//! Lifecycle:
//!   1. Caller spawns `spawn_session(...)` with a [`SshConnectConfig`]
//!      that already contains everything needed to connect (host config
//!      + decrypted credentials + port-forward rules + stored host
//!      fingerprint, if any). Returns the outbound `mpsc::Sender`.
//!   2. Inside the task we resolve TCP → run russh handshake → verify
//!      host key (TOFU) → authenticate → open channel + pty + shell.
//!   3. The task then `select!`s between inbound channel data (forwarded
//!      to `pty_tx` as `PtyEvent::Data`) and outbound `SshIoCmd`s
//!      (forwarded to russh via `Channel::data`/`window_change`).
//!   4. On any terminal condition we send `PtyEvent::Eof` so the tab
//!      loop exits cleanly.
//!
//! Persistence is the frontend's job: this module emits
//! `ssh:host_key_first_connect`, `ssh:host_key_mismatch`, and
//! `ssh:port_forward_error` events. The frontend persists fingerprints
//! and surfaces errors via the SQL plugin.

use std::sync::Arc;

use parking_lot::Mutex;
use russh::client::{self, Handle, Handler};
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::ssh_key;
use russh::{Channel, ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, EventTarget};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use zeroize::ZeroizeOnDrop;

use crate::{
    error::{AppError, AppResult},
    protocol::{
        SftpAvailability, SftpEntry, SftpTransferProgress, SshConnectError,
        SshHostKeyFirstConnect, SshHostKeyMismatch, SshPortForwardError,
    },
    tab::{PtyEvent, SftpReq, SshIoCmd},
};

/// Slot holding the SFTP session for the *current* transport. `run_session`
/// fills it after a successful connect and clears it on disconnect; the
/// long-lived `sftp_service` task reads it per request so it transparently
/// follows reconnects (and rejects requests while disconnected).
pub type SftpSlot = Arc<AsyncMutex<Option<Arc<SftpSession>>>>;

/// Registry of per-tab SFTP slots, keyed by tab id. Lets a cross-connection
/// relay reach two different sessions' SFTP channels at once (the per-tab
/// request channels only serve their own tab).
pub type SftpSlots = Arc<parking_lot::Mutex<std::collections::HashMap<u64, SftpSlot>>>;

pub fn new_sftp_slots() -> SftpSlots {
    Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new()))
}

/// Chunk size for streamed SFTP transfers.
const SFTP_CHUNK: usize = 64 * 1024;
/// Emit a progress event at most this often (bytes) to avoid flooding the
/// webview on large transfers; plus one final emit on completion.
const SFTP_PROGRESS_STRIDE: u64 = 512 * 1024;

// ---------- inbound config types ----------

/// Everything `connect_ssh_host` needs to open a session. The frontend
/// assembles this from the SQL plugin (host row + port forwards) and
/// the Stronghold plugin (secrets).
#[derive(Deserialize, Clone)]
pub struct SshConnectConfig {
    /// Used to scope all emitted events back to a specific host record.
    pub host_id: i64,
    /// Display label, used in the connection banner.
    pub label: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuthConfig,
    /// `Some(hex)` if the host has been seen before; `None` on TOFU first
    /// connect (we then emit `ssh:host_key_first_connect` so the
    /// frontend can record it).
    pub stored_fingerprint: Option<String>,
    pub forwards: Vec<SshForwardConfig>,
    /// Per-host opt-out: when true, never open the SFTP subsystem (the file
    /// browser panel won't appear). `serde(default)` keeps older saved
    /// configs deserializing cleanly.
    #[serde(default)]
    pub disable_sftp: bool,
}

/// Holds plaintext credentials only while a session is being established;
/// `ZeroizeOnDrop` wipes the heap allocations as soon as the
/// `SshConnectConfig` is dropped (which happens once the russh handshake
/// has finished and the secret has been handed off to the SSH library).
/// Note: russh's internal copy of the password/key bytes is not under our
/// control — this only guarantees our own buffers are scrubbed.
#[derive(Deserialize, Clone, ZeroizeOnDrop)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SshAuthConfig {
    Password {
        password: String,
    },
    Key {
        private_key: String,
        passphrase: Option<String>,
    },
    Agent,
}

#[derive(Deserialize, Clone)]
pub struct SshForwardConfig {
    /// DB row id, propagated back through error events so the frontend
    /// can highlight the offending rule.
    pub id: Option<i64>,
    pub kind: SshForwardKind,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum SshForwardKind {
    Local,
    Remote,
    Dynamic,
}

// ---------- russh handler ----------

/// Mutable state shared with the handler once russh owns it.
#[derive(Default)]
struct HandlerState {
    /// `(fp, alg)` captured on TOFU first connect — flushed via event.
    captured_fp: Option<(String, String)>,
    /// True when `check_server_key` rejected the host key.
    host_key_rejected: bool,
    /// Routing table for inbound forwarded-tcpip channels (remote `-R`).
    remote_forwards: Vec<RemoteForwardRoute>,
}

#[derive(Clone, Debug)]
struct RemoteForwardRoute {
    bind_host: String,
    bind_port: u16,
    target_host: String,
    target_port: u16,
}

struct ClientHandler {
    stored_fp: Option<String>,
    app: AppHandle,
    owner_window: String,
    tab_id: u64,
    host_id: i64,
    state: Arc<Mutex<HandlerState>>,
}

#[async_trait::async_trait]
impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let route = {
            let s = self.state.lock();
            s.remote_forwards
                .iter()
                .find(|r| {
                    r.bind_port as u32 == connected_port
                        && (r.bind_host == connected_address
                            || r.bind_host == "0.0.0.0"
                            || r.bind_host == "*"
                            || r.bind_host.is_empty())
                })
                .cloned()
        };
        let Some(route) = route else {
            eprintln!(
                "[ssh] unsolicited forwarded-tcpip to {connected_address}:{connected_port}"
            );
            return Ok(());
        };
        tokio::spawn(async move {
            let target = format!("{}:{}", route.target_host, route.target_port);
            match TcpStream::connect(&target).await {
                Ok(sock) => pipe_socket_channel(sock, channel).await,
                Err(e) => eprintln!("[ssh] remote forward target {target} dial failed: {e}"),
            }
        });
        Ok(())
    }

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let alg = server_public_key.algorithm().to_string();
        let fp = server_public_key
            .fingerprint(ssh_key::HashAlg::Sha256)
            .to_string();

        match &self.stored_fp {
            None => {
                self.state.lock().captured_fp = Some((fp, alg));
                Ok(true)
            }
            Some(stored) if stored == &fp => Ok(true),
            Some(stored) => {
                let _ = self.app.emit_to(
                    EventTarget::webview_window(&self.owner_window),
                    "ssh:host_key_mismatch",
                    SshHostKeyMismatch {
                        tab_id: self.tab_id,
                        host_id: self.host_id,
                        stored_fp: stored.clone(),
                        received_fp: fp,
                        algorithm: alg,
                    },
                );
                self.state.lock().host_key_rejected = true;
                Ok(false)
            }
        }
    }
}

// ---------- session lifecycle ----------

/// Spawn the SSH session on the supplied tokio runtime. Returns the
/// outbound shell command channel and the SFTP request channel.
#[allow(clippy::too_many_arguments)]
pub fn spawn_session(
    rt: &tokio::runtime::Runtime,
    app: AppHandle,
    owner_window: String,
    tab_id: u64,
    config: SshConnectConfig,
    pty_tx: crossbeam_channel::Sender<PtyEvent>,
    cols: u16,
    rows: u16,
    slots: SftpSlots,
) -> (mpsc::Sender<SshIoCmd>, mpsc::Sender<SftpReq>) {
    let (out_tx, out_rx) = mpsc::channel::<SshIoCmd>(128);
    let (sftp_tx, sftp_rx) = mpsc::channel::<SftpReq>(32);
    // The slot's content follows reconnects; the registry entry is stable for
    // the tab's lifetime so a relay can always find it.
    let sftp_slot: SftpSlot = Arc::new(AsyncMutex::new(None));
    slots.lock().insert(tab_id, sftp_slot.clone());
    rt.spawn(session_task(
        app,
        owner_window,
        tab_id,
        config,
        pty_tx,
        out_rx,
        sftp_rx,
        cols,
        rows,
        sftp_slot,
        slots,
    ));
    (out_tx, sftp_tx)
}

/// Why a single connect+drive attempt stopped. Decides whether
/// `session_task` reconnects or lets the tab close.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SessionOutcome {
    /// Tab is being closed locally (user closed it / VT thread gone).
    LocalClose,
    /// Remote shell exited cleanly (`exit`/logout, exit status/signal).
    RemoteExit,
    /// Transport vanished unexpectedly — candidate for auto-reconnect.
    Dropped,
    /// Host key changed; the mismatch dialog was shown. Never reconnect.
    Rejected,
}

#[allow(clippy::too_many_arguments)]
async fn session_task(
    app: AppHandle,
    owner_window: String,
    tab_id: u64,
    config: SshConnectConfig,
    pty_tx: crossbeam_channel::Sender<PtyEvent>,
    mut out_rx: mpsc::Receiver<SshIoCmd>,
    sftp_rx: mpsc::Receiver<SftpReq>,
    cols: u16,
    rows: u16,
    sftp_slot: SftpSlot,
    slots: SftpSlots,
) {
    // Preserve host identity for the error event; `config` is borrowed by
    // each attempt so it survives reconnects (credentials included).
    let host_id = config.host_id;
    let host_label = config.label.clone();
    let hostname = config.hostname.clone();

    // One SFTP service task lives for the whole session (across reconnects).
    // It reads the current `SftpSession` from the shared slot that
    // `run_session` populates/clears, so it follows reconnects without
    // re-plumbing the receiver, and rejects requests while the transport is
    // down.
    let sftp_service = tokio::spawn(sftp_service(
        sftp_rx,
        sftp_slot.clone(),
        app.clone(),
        owner_window.clone(),
        tab_id,
    ));
    // These outlive a single transport and are threaded through every
    // attempt: the latest terminal size (so a reconnect requests the right
    // PTY), the now-known host fingerprint (so a key change is still caught
    // on reconnect), and whether we ever got a working shell (gates the
    // reconnect-vs-give-up decision).
    let mut cols = cols;
    let mut rows = rows;
    let mut stored_fp = config.stored_fingerprint.clone();
    let mut ever_established = false;
    let mut backoff_secs = 1u64;

    loop {
        let result = run_session(
            &app,
            &owner_window,
            tab_id,
            &config,
            &pty_tx,
            &mut out_rx,
            &mut cols,
            &mut rows,
            &mut stored_fp,
            &sftp_slot,
        )
        .await;

        match result {
            // Intentional stops — let the tab close.
            Ok((SessionOutcome::LocalClose, _))
            | Ok((SessionOutcome::RemoteExit, _))
            | Ok((SessionOutcome::Rejected, _)) => break,
            // Unexpected drop of a working session — reconnect. A good
            // connection just died, so restart the backoff from scratch.
            Ok((SessionOutcome::Dropped, _)) => {
                ever_established = true;
                backoff_secs = 1;
            }
            Err(e) => {
                let raw = e.to_string();
                if !ever_established {
                    // First connect failed: keep the existing modal UX and
                    // give up (the tab closes).
                    let msg = format!("\r\n\x1b[31mSSH error:\x1b[0m {}\r\n", raw);
                    let _ = pty_tx.send(PtyEvent::Data(msg.into_bytes()));
                    let _ = app.emit_to(
                        EventTarget::webview_window(&owner_window),
                        "ssh:connect_error",
                        SshConnectError {
                            tab_id,
                            host_id,
                            host_label,
                            hostname,
                            kind: classify_connect_error(&raw).to_string(),
                            message: raw,
                        },
                    );
                    break;
                }
                // A reconnect attempt failed; report it and keep retrying
                // (backoff keeps growing).
                let msg = format!("\r\n\x1b[31mreconnect failed:\x1b[0m {}\r\n", raw);
                let _ = pty_tx.send(PtyEvent::Data(msg.into_bytes()));
            }
        }

        // Only reached when we intend to reconnect.
        let _ = pty_tx.send(PtyEvent::Data(
            "\r\n\x1b[33m\u{26a0} connection lost \u{2014} reconnecting\u{2026}\x1b[0m\r\n"
                .as_bytes()
                .to_vec(),
        ));
        if wait_or_close(&mut out_rx, &mut cols, &mut rows, backoff_secs).await {
            break; // tab closed during the backoff wait
        }
        backoff_secs = (backoff_secs * 2).min(30);
    }
    sftp_service.abort();
    slots.lock().remove(&tab_id);
    let _ = pty_tx.send(PtyEvent::Eof);
}

/// Backoff wait that stays responsive to tab-close. Returns `true` if the
/// tab is being closed (so the caller stops reconnecting). Resize commands
/// update the tracked terminal size; queued input is discarded — the old
/// shell is gone and replaying stale keystrokes into a fresh one is wrong.
async fn wait_or_close(
    out_rx: &mut mpsc::Receiver<SshIoCmd>,
    cols: &mut u16,
    rows: &mut u16,
    secs: u64,
) -> bool {
    let sleep = tokio::time::sleep(std::time::Duration::from_secs(secs));
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            biased;
            cmd = out_rx.recv() => match cmd {
                Some(SshIoCmd::Close) | None => return true,
                Some(SshIoCmd::Resize { cols: c, rows: r, .. }) => {
                    *cols = c;
                    *rows = r;
                }
                Some(SshIoCmd::Write(_)) => {}
            },
            _ = &mut sleep => return false,
        }
    }
}

/// Coarse classification of an SSH error string so the frontend can pick
/// a sensible title. The prefixes here mirror the `format!` calls in
/// `run_session` / `authenticate`.
fn classify_connect_error(msg: &str) -> &'static str {
    let lower = msg.to_lowercase();
    if lower.contains("authentication failed")
        || lower.contains("password auth")
        || lower.contains("publickey auth")
        || lower.contains("parse private key")
        || lower.contains("key wrap")
        || lower.contains("agent auth")
    {
        "auth"
    } else if lower.starts_with("connect:")
        || lower.contains("could not resolve")
        || lower.contains("io error")
        || lower.contains("connection refused")
    {
        "connect"
    } else if lower.contains("channel open")
        || lower.contains("request pty")
        || lower.contains("request shell")
    {
        "channel"
    } else {
        "other"
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_session(
    app: &AppHandle,
    owner_window: &str,
    tab_id: u64,
    config: &SshConnectConfig,
    pty_tx: &crossbeam_channel::Sender<PtyEvent>,
    out_rx: &mut mpsc::Receiver<SshIoCmd>,
    cols: &mut u16,
    rows: &mut u16,
    stored_fp: &mut Option<String>,
    sftp_slot: &SftpSlot,
) -> AppResult<(SessionOutcome, bool)> {
    let host_id = config.host_id;
    let russh_config = Arc::new(client::Config {
        inactivity_timeout: None,
        ..Default::default()
    });

    // Pre-populate remote-forward routing so the handler can dispatch
    // inbound `forwarded-tcpip` channels without a back-channel.
    let mut handler_state = HandlerState::default();
    for f in config.forwards.iter() {
        if !matches!(f.kind, SshForwardKind::Remote) {
            continue;
        }
        if let (Some(th), Some(tp)) = (f.target_host.clone(), f.target_port) {
            handler_state.remote_forwards.push(RemoteForwardRoute {
                bind_host: f.bind_host.clone(),
                bind_port: f.bind_port,
                target_host: th,
                target_port: tp,
            });
        }
    }
    let state = Arc::new(Mutex::new(handler_state));
    let handler = ClientHandler {
        stored_fp: stored_fp.clone(),
        app: app.clone(),
        owner_window: owner_window.to_string(),
        tab_id,
        host_id,
        state: state.clone(),
    };

    let addr = format!("{}:{}", config.hostname, config.port);
    let banner = format!(
        "\r\n\x1b[36m\u{2192} connecting to {} ({})\u{2026}\x1b[0m\r\n",
        config.label, addr,
    );
    let _ = pty_tx.send(PtyEvent::Data(banner.into_bytes()));

    let mut session = client::connect(russh_config, &addr, handler)
        .await
        .map_err(|e| AppError::Ssh(format!("connect: {e}")))?;

    let auth_ok = authenticate(&mut session, &config.username, &config.auth).await?;
    if !auth_ok {
        if state.lock().host_key_rejected {
            let _ = pty_tx.send(PtyEvent::Data(
                "\r\n\x1b[31m\u{2717} host key changed \u{2014} see dialog.\x1b[0m\r\n"
                    .as_bytes()
                    .to_vec(),
            ));
            let _ = session.disconnect(Disconnect::ByApplication, "", "").await;
            return Ok((SessionOutcome::Rejected, false));
        }
        return Err(AppError::Ssh(
            "authentication failed (check password / key / agent identities)".into(),
        ));
    }

    // TOFU: emit the captured fingerprint so the frontend can persist it,
    // and remember it locally so a key change is still detected if this
    // session later reconnects.
    if let Some((fp, alg)) = state.lock().captured_fp.take() {
        *stored_fp = Some(fp.clone());
        let _ = app.emit_to(
            EventTarget::webview_window(owner_window),
            "ssh:host_key_first_connect",
            SshHostKeyFirstConnect {
                tab_id,
                host_id,
                fingerprint: fp,
                algorithm: alg,
            },
        );
    }

    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("channel open: {e}")))?;
    channel
        .request_pty(false, "xterm-256color", *cols as u32, *rows as u32, 0, 0, &[])
        .await
        .map_err(|e| AppError::Ssh(format!("request pty: {e}")))?;
    channel
        .request_shell(false)
        .await
        .map_err(|e| AppError::Ssh(format!("request shell: {e}")))?;

    let _ = pty_tx.send(PtyEvent::Data(
        "\r\n\x1b[32m\u{2713} connected.\x1b[0m\r\n".as_bytes().to_vec(),
    ));

    // Share the Handle with forward tasks (the shell channel is owned
    // by the loop below).
    let session = Arc::new(tokio::sync::Mutex::new(session));
    let mut forward_tasks: Vec<JoinHandle<()>> = Vec::new();
    for fw in config.forwards.clone() {
        let handle = session.clone();
        let app_for_task = app.clone();
        let window_for_task = owner_window.to_string();
        let fw_id = fw.id;
        let task = tokio::spawn(async move {
            if let Err(e) = run_forward(handle, fw).await {
                let _ = app_for_task.emit_to(
                    EventTarget::webview_window(&window_for_task),
                    "ssh:port_forward_error",
                    SshPortForwardError {
                        tab_id,
                        host_id,
                        forward_id: fw_id,
                        message: e.to_string(),
                    },
                );
            }
        });
        forward_tasks.push(task);
    }

    // Best-effort SFTP subsystem on a second channel of the same session.
    // Failures (server without the subsystem, or the per-host opt-out) leave
    // the slot empty so the panel shows "unavailable" — the shell is unaffected.
    let sftp = if config.disable_sftp {
        None
    } else {
        open_sftp(&session).await
    };
    let sftp_available = sftp.is_some();
    *sftp_slot.lock().await = sftp;
    // Tell the (already-mounted) panel SFTP is ready to query — it waits for
    // this rather than failing on the pre-handshake race, and reloads on each
    // reconnect. `false` means the host doesn't offer the subsystem.
    let _ = app.emit_to(
        EventTarget::webview_window(owner_window),
        "sftp:availability",
        SftpAvailability {
            tab_id,
            available: sftp_available,
        },
    );

    let outcome = drive_channel_loop(&mut channel, pty_tx, out_rx, cols, rows).await;

    // Drop the SFTP session before tearing down the transport so in-flight
    // browser requests fail fast (and so a reconnect installs a fresh one).
    *sftp_slot.lock().await = None;

    for t in forward_tasks {
        t.abort();
    }

    let s = session.lock().await;
    let _ = s.disconnect(Disconnect::ByApplication, "", "").await;
    Ok((outcome, true))
}

/// Open the SFTP subsystem on a fresh channel of an established session.
/// Returns `None` (logging at the call sites) on any failure so the caller
/// can degrade gracefully.
async fn open_sftp(session: &Arc<tokio::sync::Mutex<Handle<ClientHandler>>>) -> Option<Arc<SftpSession>> {
    let channel = match session.lock().await.channel_open_session().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[sftp] channel open failed: {e}");
            return None;
        }
    };
    if let Err(e) = channel.request_subsystem(true, "sftp").await {
        eprintln!("[sftp] subsystem request failed: {e}");
        return None;
    }
    match SftpSession::new(channel.into_stream()).await {
        Ok(s) => Some(Arc::new(s)),
        Err(e) => {
            eprintln!("[sftp] session init failed: {e}");
            None
        }
    }
}

async fn authenticate<H: Handler>(
    session: &mut Handle<H>,
    username: &str,
    auth: &SshAuthConfig,
) -> AppResult<bool> {
    match auth {
        SshAuthConfig::Password { password } => session
            .authenticate_password(username.to_string(), password)
            .await
            .map_err(|e| AppError::Ssh(format!("password auth: {e}"))),
        SshAuthConfig::Key {
            private_key,
            passphrase,
        } => {
            let key = russh::keys::decode_secret_key(private_key, passphrase.as_deref())
                .map_err(|e| AppError::Ssh(format!("parse private key: {e}")))?;
            let kp = PrivateKeyWithHashAlg::new(Arc::new(key), None)
                .map_err(|e| AppError::Ssh(format!("key wrap: {e}")))?;
            session
                .authenticate_publickey(username.to_string(), kp)
                .await
                .map_err(|e| AppError::Ssh(format!("publickey auth: {e}")))
        }
        SshAuthConfig::Agent => agent_authenticate(session, username).await,
    }
}

// ssh-agent auth needs a Unix domain socket via `SSH_AUTH_SOCK`. macOS
// and Linux desktop both ship one. iOS/Android sandbox both forbid it,
// and Windows uses a named pipe that russh's `connect_env()` doesn't
// speak. Hide the path on those targets so the rest of the SSH client
// still builds; the frontend should also hide the "ssh-agent" option in
// the host editor.
#[cfg(all(unix, not(any(target_os = "ios", target_os = "android"))))]
async fn agent_authenticate<H: Handler>(
    session: &mut Handle<H>,
    username: &str,
) -> AppResult<bool> {
    let mut agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| AppError::Ssh(format!("connect ssh-agent: {e}")))?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| AppError::Ssh(format!("agent identities: {e}")))?;
    if identities.is_empty() {
        return Err(AppError::Ssh(
            "ssh-agent has no identities loaded (try `ssh-add`)".into(),
        ));
    }
    for pubkey in identities {
        let ok = session
            .authenticate_publickey_with(username.to_string(), pubkey, &mut agent)
            .await
            .map_err(|e| AppError::Ssh(format!("agent auth: {e}")))?;
        if ok {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(not(all(unix, not(any(target_os = "ios", target_os = "android")))))]
async fn agent_authenticate<H: Handler>(
    _session: &mut Handle<H>,
    _username: &str,
) -> AppResult<bool> {
    Err(AppError::Ssh(
        "ssh-agent authentication is not available on this platform".into(),
    ))
}

async fn drive_channel_loop(
    channel: &mut Channel<client::Msg>,
    pty_tx: &crossbeam_channel::Sender<PtyEvent>,
    out_rx: &mut mpsc::Receiver<SshIoCmd>,
    cols: &mut u16,
    rows: &mut u16,
) -> SessionOutcome {
    loop {
        tokio::select! {
            biased;
            cmd = out_rx.recv() => {
                match cmd {
                    Some(SshIoCmd::Write(bytes)) => {
                        if let Err(e) = channel.data(&bytes[..]).await {
                            eprintln!("[ssh] write to channel failed: {e:?}");
                            return SessionOutcome::Dropped;
                        }
                    }
                    Some(SshIoCmd::Resize { cols: c, rows: r, w_px, h_px }) => {
                        *cols = c;
                        *rows = r;
                        let _ = channel
                            .window_change(c as u32, r as u32, w_px, h_px)
                            .await;
                    }
                    Some(SshIoCmd::Close) | None => {
                        let _ = channel.eof().await;
                        return SessionOutcome::LocalClose;
                    }
                }
            }
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        if pty_tx.send(PtyEvent::Data(data.to_vec())).is_err() {
                            return SessionOutcome::LocalClose;
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if pty_tx.send(PtyEvent::Data(data.to_vec())).is_err() {
                            return SessionOutcome::LocalClose;
                        }
                    }
                    Some(ChannelMsg::Eof) => {
                        // Server signalled EOF; wait for ExitStatus too.
                    }
                    Some(ChannelMsg::ExitStatus { .. })
                    | Some(ChannelMsg::ExitSignal { .. }) => {
                        return SessionOutcome::RemoteExit;
                    }
                    None => return SessionOutcome::Dropped,
                    _ => {}
                }
            }
        }
    }
}

// ---------- port forwards ----------

async fn run_forward(
    session: Arc<tokio::sync::Mutex<Handle<ClientHandler>>>,
    fw: SshForwardConfig,
) -> AppResult<()> {
    match fw.kind {
        SshForwardKind::Local => run_local_forward(session, fw).await,
        SshForwardKind::Dynamic => run_dynamic_forward(session, fw).await,
        SshForwardKind::Remote => run_remote_forward(session, fw).await,
    }
}

async fn run_local_forward(
    session: Arc<tokio::sync::Mutex<Handle<ClientHandler>>>,
    fw: SshForwardConfig,
) -> AppResult<()> {
    let target_host = fw
        .target_host
        .clone()
        .ok_or_else(|| AppError::Ssh("local forward missing target_host".into()))?;
    let target_port = fw
        .target_port
        .ok_or_else(|| AppError::Ssh("local forward missing target_port".into()))?;

    let bind_addr = format!("{}:{}", fw.bind_host, fw.bind_port);
    let listener = TcpListener::bind(&bind_addr)
        .await
        .map_err(|e| AppError::Ssh(format!("bind {bind_addr}: {e}")))?;
    eprintln!("[ssh] local forward listening on {bind_addr} → {target_host}:{target_port}");

    loop {
        let (sock, _peer) = listener
            .accept()
            .await
            .map_err(|e| AppError::Ssh(format!("accept: {e}")))?;
        let session = session.clone();
        let target_host = target_host.clone();
        tokio::spawn(async move {
            let chan = {
                let s = session.lock().await;
                s.channel_open_direct_tcpip(target_host, target_port as u32, "127.0.0.1", 0)
                    .await
            };
            match chan {
                Ok(chan) => pipe_socket_channel(sock, chan).await,
                Err(e) => eprintln!("[ssh] direct-tcpip open failed: {e:?}"),
            }
        });
    }
}

async fn run_dynamic_forward(
    session: Arc<tokio::sync::Mutex<Handle<ClientHandler>>>,
    fw: SshForwardConfig,
) -> AppResult<()> {
    let bind_addr = format!("{}:{}", fw.bind_host, fw.bind_port);
    let listener = TcpListener::bind(&bind_addr)
        .await
        .map_err(|e| AppError::Ssh(format!("bind {bind_addr}: {e}")))?;
    eprintln!("[ssh] dynamic (SOCKS5) forward listening on {bind_addr}");

    loop {
        let (sock, _peer) = listener
            .accept()
            .await
            .map_err(|e| AppError::Ssh(format!("accept: {e}")))?;
        let session = session.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_socks5(sock, session).await {
                eprintln!("[ssh] socks5 connection failed: {e}");
            }
        });
    }
}

async fn handle_socks5(
    mut sock: TcpStream,
    session: Arc<tokio::sync::Mutex<Handle<ClientHandler>>>,
) -> AppResult<()> {
    let mut hdr = [0u8; 2];
    sock.read_exact(&mut hdr)
        .await
        .map_err(|e| AppError::Ssh(format!("socks read greeting: {e}")))?;
    if hdr[0] != 5 {
        return Err(AppError::Ssh("socks: not v5".into()));
    }
    let mut methods = vec![0u8; hdr[1] as usize];
    sock.read_exact(&mut methods)
        .await
        .map_err(|e| AppError::Ssh(format!("socks read methods: {e}")))?;
    sock.write_all(&[5, 0])
        .await
        .map_err(|e| AppError::Ssh(format!("socks write greeting reply: {e}")))?;

    let mut req = [0u8; 4];
    sock.read_exact(&mut req)
        .await
        .map_err(|e| AppError::Ssh(format!("socks read request: {e}")))?;
    if req[0] != 5 {
        return Err(AppError::Ssh("socks: bad request version".into()));
    }
    if req[1] != 1 {
        sock.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await.ok();
        return Err(AppError::Ssh(format!(
            "socks: unsupported command {}",
            req[1]
        )));
    }
    let atyp = req[3];
    let target_host = match atyp {
        0x01 => {
            let mut a = [0u8; 4];
            sock.read_exact(&mut a)
                .await
                .map_err(|e| AppError::Ssh(format!("socks ipv4: {e}")))?;
            format!("{}.{}.{}.{}", a[0], a[1], a[2], a[3])
        }
        0x03 => {
            let mut len = [0u8; 1];
            sock.read_exact(&mut len)
                .await
                .map_err(|e| AppError::Ssh(format!("socks domain len: {e}")))?;
            let mut name = vec![0u8; len[0] as usize];
            sock.read_exact(&mut name)
                .await
                .map_err(|e| AppError::Ssh(format!("socks domain: {e}")))?;
            String::from_utf8(name).map_err(|_| AppError::Ssh("socks domain not utf-8".into()))?
        }
        0x04 => {
            let mut a = [0u8; 16];
            sock.read_exact(&mut a)
                .await
                .map_err(|e| AppError::Ssh(format!("socks ipv6: {e}")))?;
            let segs: [u16; 8] = [
                u16::from_be_bytes([a[0], a[1]]),
                u16::from_be_bytes([a[2], a[3]]),
                u16::from_be_bytes([a[4], a[5]]),
                u16::from_be_bytes([a[6], a[7]]),
                u16::from_be_bytes([a[8], a[9]]),
                u16::from_be_bytes([a[10], a[11]]),
                u16::from_be_bytes([a[12], a[13]]),
                u16::from_be_bytes([a[14], a[15]]),
            ];
            std::net::Ipv6Addr::new(
                segs[0], segs[1], segs[2], segs[3], segs[4], segs[5], segs[6], segs[7],
            )
            .to_string()
        }
        _ => {
            sock.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await.ok();
            return Err(AppError::Ssh(format!("socks unknown atyp {atyp}")));
        }
    };
    let mut p = [0u8; 2];
    sock.read_exact(&mut p)
        .await
        .map_err(|e| AppError::Ssh(format!("socks port: {e}")))?;
    let target_port = u16::from_be_bytes(p);

    let chan = {
        let s = session.lock().await;
        s.channel_open_direct_tcpip(target_host.clone(), target_port as u32, "127.0.0.1", 0)
            .await
    };
    let chan = match chan {
        Ok(c) => c,
        Err(e) => {
            sock.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await.ok();
            return Err(AppError::Ssh(format!(
                "direct-tcpip {target_host}:{target_port}: {e:?}"
            )));
        }
    };

    sock.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|e| AppError::Ssh(format!("socks success reply: {e}")))?;

    pipe_socket_channel(sock, chan).await;
    Ok(())
}

async fn run_remote_forward(
    session: Arc<tokio::sync::Mutex<Handle<ClientHandler>>>,
    fw: SshForwardConfig,
) -> AppResult<()> {
    let mut s = session.lock().await;
    let assigned = s
        .tcpip_forward(fw.bind_host.clone(), fw.bind_port as u32)
        .await
        .map_err(|e| AppError::Ssh(format!("tcpip_forward {}: {e}", fw.bind_host)))?;
    eprintln!(
        "[ssh] remote forward requested: server listening on {}:{} (assigned {})",
        fw.bind_host, fw.bind_port, assigned
    );
    Ok(())
}

async fn pipe_socket_channel(sock: TcpStream, chan: Channel<client::Msg>) {
    let mut stream = chan.into_stream();
    let mut sock = sock;
    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
}

// ---------- sftp ----------

/// Long-lived task draining the per-tab SFTP request channel. Reads the
/// current `SftpSession` from `slot` per request (so it follows reconnects);
/// rejects everything while the transport is down. Metadata ops run inline
/// (fast, and naturally serialized); transfers are spawned so a big file
/// doesn't block browsing.
async fn sftp_service(
    mut rx: mpsc::Receiver<SftpReq>,
    slot: SftpSlot,
    app: AppHandle,
    window: String,
    tab_id: u64,
) {
    while let Some(req) = rx.recv().await {
        let current = slot.lock().await.clone();
        let Some(sftp) = current else {
            reject_sftp(req, "SFTP is not connected");
            continue;
        };
        match req {
            SftpReq::Download { .. } | SftpReq::Upload { .. } => {
                let app = app.clone();
                let window = window.clone();
                tokio::spawn(async move {
                    run_sftp_transfer(sftp, app, window, tab_id, req).await;
                });
            }
            other => run_sftp_meta(&sftp, other).await,
        }
    }
}

fn sftp_err<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Ssh(format!("sftp: {e}"))
}

/// Send a uniform error to whichever reply channel a request carries — used
/// when no session is available. The error is built per-arm because each
/// reply's `T` differs (a single closure would fix one concrete type).
fn reject_sftp(req: SftpReq, msg: &str) {
    match req {
        SftpReq::List { reply, .. } => {
            let _ = reply.send(Err(AppError::Ssh(msg.to_string())));
        }
        SftpReq::Realpath { reply, .. } => {
            let _ = reply.send(Err(AppError::Ssh(msg.to_string())));
        }
        SftpReq::Stat { reply, .. } => {
            let _ = reply.send(Err(AppError::Ssh(msg.to_string())));
        }
        SftpReq::Mkdir { reply, .. } => {
            let _ = reply.send(Err(AppError::Ssh(msg.to_string())));
        }
        SftpReq::Rename { reply, .. } => {
            let _ = reply.send(Err(AppError::Ssh(msg.to_string())));
        }
        SftpReq::Remove { reply, .. } => {
            let _ = reply.send(Err(AppError::Ssh(msg.to_string())));
        }
        SftpReq::Download { reply, .. } => {
            let _ = reply.send(Err(AppError::Ssh(msg.to_string())));
        }
        SftpReq::Upload { reply, .. } => {
            let _ = reply.send(Err(AppError::Ssh(msg.to_string())));
        }
    }
}

fn join_remote(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn remote_basename(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some((_, base)) if !base.is_empty() => base.to_string(),
        _ => trimmed.to_string(),
    }
}

fn make_entry(name: String, path: String, md: &russh_sftp::protocol::FileAttributes) -> SftpEntry {
    SftpEntry {
        is_dir: md.is_dir(),
        is_symlink: md.is_symlink(),
        size: md.size.unwrap_or(0),
        mtime: md.mtime.map(|t| t as u64),
        mode: md.permissions,
        name,
        path,
    }
}

async fn run_sftp_meta(sftp: &SftpSession, req: SftpReq) {
    match req {
        SftpReq::List { path, reply } => {
            let _ = reply.send(sftp_list(sftp, &path).await);
        }
        SftpReq::Realpath { path, reply } => {
            let _ = reply.send(sftp.canonicalize(path).await.map_err(sftp_err));
        }
        SftpReq::Stat { path, reply } => {
            let _ = reply.send(sftp_stat(sftp, &path).await);
        }
        SftpReq::Mkdir { path, reply } => {
            let _ = reply.send(sftp.create_dir(path).await.map_err(sftp_err));
        }
        SftpReq::Rename { from, to, reply } => {
            let _ = reply.send(sftp.rename(from, to).await.map_err(sftp_err));
        }
        SftpReq::Remove {
            path,
            is_dir,
            reply,
        } => {
            let r = if is_dir {
                sftp.remove_dir(path).await
            } else {
                sftp.remove_file(path).await
            };
            let _ = reply.send(r.map_err(sftp_err));
        }
        // Transfers are dispatched separately by `sftp_service`.
        SftpReq::Download { .. } | SftpReq::Upload { .. } => {}
    }
}

async fn sftp_list(sftp: &SftpSession, dir: &str) -> AppResult<Vec<SftpEntry>> {
    let rd = sftp.read_dir(dir).await.map_err(sftp_err)?;
    let mut out = Vec::new();
    for entry in rd {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let md = entry.metadata();
        let path = join_remote(dir, &name);
        out.push(make_entry(name, path, &md));
    }
    // Directories first, then case-insensitive by name — a sensible default
    // the frontend can re-sort if needed.
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

async fn sftp_stat(sftp: &SftpSession, path: &str) -> AppResult<SftpEntry> {
    let md = sftp.metadata(path).await.map_err(sftp_err)?;
    Ok(make_entry(remote_basename(path), path.to_string(), &md))
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    app: &AppHandle,
    window: &str,
    tab_id: u64,
    transfer_id: u64,
    transferred: u64,
    total: Option<u64>,
    done: bool,
    error: Option<String>,
) {
    let _ = app.emit_to(
        EventTarget::webview_window(window),
        "sftp:transfer_progress",
        SftpTransferProgress {
            tab_id,
            transfer_id,
            transferred,
            total,
            done,
            error,
        },
    );
}

async fn run_sftp_transfer(
    sftp: Arc<SftpSession>,
    app: AppHandle,
    window: String,
    tab_id: u64,
    req: SftpReq,
) {
    match req {
        SftpReq::Download {
            remote,
            local,
            transfer_id,
            reply,
        } => {
            let r = sftp_download(&sftp, &app, &window, tab_id, transfer_id, &remote, &local).await;
            let _ = reply.send(r);
        }
        SftpReq::Upload {
            local,
            remote,
            transfer_id,
            reply,
        } => {
            let r = sftp_upload(&sftp, &app, &window, tab_id, transfer_id, &local, &remote).await;
            let _ = reply.send(r);
        }
        _ => {}
    }
}

#[allow(clippy::too_many_arguments)]
async fn sftp_download(
    sftp: &SftpSession,
    app: &AppHandle,
    window: &str,
    tab_id: u64,
    transfer_id: u64,
    remote: &str,
    local: &std::path::Path,
) -> AppResult<()> {
    let total = sftp.metadata(remote).await.ok().and_then(|m| m.size);
    let result = async {
        let mut rf = sftp.open(remote).await.map_err(sftp_err)?;
        let mut lf = tokio::fs::File::create(local).await?;
        let mut buf = vec![0u8; SFTP_CHUNK];
        let mut transferred = 0u64;
        let mut last = 0u64;
        loop {
            let n = rf.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            lf.write_all(&buf[..n]).await?;
            transferred += n as u64;
            if transferred - last >= SFTP_PROGRESS_STRIDE {
                last = transferred;
                emit_progress(app, window, tab_id, transfer_id, transferred, total, false, None);
            }
        }
        lf.flush().await?;
        Ok::<u64, AppError>(transferred)
    }
    .await;
    finish_transfer(app, window, tab_id, transfer_id, total, result)
}

#[allow(clippy::too_many_arguments)]
async fn sftp_upload(
    sftp: &SftpSession,
    app: &AppHandle,
    window: &str,
    tab_id: u64,
    transfer_id: u64,
    local: &std::path::Path,
    remote: &str,
) -> AppResult<()> {
    let is_dir = tokio::fs::metadata(local)
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false);
    if is_dir {
        return sftp_upload_dir(sftp, app, window, tab_id, transfer_id, local, remote).await;
    }
    let total = tokio::fs::metadata(local).await.ok().map(|m| m.len());
    let result = async {
        let mut lf = tokio::fs::File::open(local).await?;
        let mut rf = sftp
            .open_with_flags(
                remote,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(sftp_err)?;
        let mut buf = vec![0u8; SFTP_CHUNK];
        let mut transferred = 0u64;
        let mut last = 0u64;
        loop {
            let n = lf.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            rf.write_all(&buf[..n]).await?;
            transferred += n as u64;
            if transferred - last >= SFTP_PROGRESS_STRIDE {
                last = transferred;
                emit_progress(app, window, tab_id, transfer_id, transferred, total, false, None);
            }
        }
        // Flush + send the SFTP close so the server commits the file.
        rf.shutdown().await?;
        Ok::<u64, AppError>(transferred)
    }
    .await;
    finish_transfer(app, window, tab_id, transfer_id, total, result)
}

/// Join a remote (POSIX, `/`-separated) base path with a local relative path,
/// using forward slashes regardless of the host OS's separator.
fn remote_join(base: &str, rel: &std::path::Path) -> String {
    let mut s = base.trim_end_matches('/').to_string();
    for comp in rel.components() {
        if let std::path::Component::Normal(c) = comp {
            s.push('/');
            s.push_str(&c.to_string_lossy());
        }
    }
    s
}

/// Walk a local directory tree breadth-first. Returns the subdirectories
/// (parents always listed before their children, so they can be created in
/// order), the regular files with their sizes, and the total byte count.
async fn collect_local_tree(
    root: &std::path::Path,
) -> std::io::Result<(
    Vec<std::path::PathBuf>,
    Vec<std::path::PathBuf>,
    u64,
)> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    let mut total = 0u64;
    let mut queue = vec![root.to_path_buf()];
    let mut i = 0;
    while i < queue.len() {
        let dir = queue[i].clone();
        i += 1;
        let mut rd = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = rd.next_entry().await? {
            let ft = entry.file_type().await?;
            let path = entry.path();
            if ft.is_dir() {
                dirs.push(path.clone());
                queue.push(path);
            } else if ft.is_file() {
                total += entry.metadata().await.map(|m| m.len()).unwrap_or(0);
                files.push(path);
            }
            // Symlinks and other special files are skipped.
        }
    }
    Ok((dirs, files, total))
}

/// Recursively upload a local directory: mkdir the destination tree (best
/// effort — existing dirs are fine) then stream every file, emitting a single
/// transfer's progress against the summed byte total.
#[allow(clippy::too_many_arguments)]
async fn sftp_upload_dir(
    sftp: &SftpSession,
    app: &AppHandle,
    window: &str,
    tab_id: u64,
    transfer_id: u64,
    local: &std::path::Path,
    remote: &str,
) -> AppResult<()> {
    let (dirs, files, bytes) = match collect_local_tree(local).await {
        Ok(t) => t,
        Err(e) => return finish_transfer(app, window, tab_id, transfer_id, None, Err(e.into())),
    };
    let total = Some(bytes);
    let result = async {
        // Create the destination root and every subdirectory (parents first).
        // `create_dir` errors are ignored: a dir that already exists is fine,
        // and a genuine failure will surface when we try to write a file into it.
        let _ = sftp.create_dir(remote).await;
        for d in &dirs {
            let rel = d.strip_prefix(local).unwrap_or(d);
            let _ = sftp.create_dir(&remote_join(remote, rel)).await;
        }
        let mut buf = vec![0u8; SFTP_CHUNK];
        let mut transferred = 0u64;
        let mut last = 0u64;
        for f in &files {
            let rel = f.strip_prefix(local).unwrap_or(f);
            let rpath = remote_join(remote, rel);
            let mut lf = tokio::fs::File::open(f).await?;
            let mut rf = sftp
                .open_with_flags(
                    &rpath,
                    OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                )
                .await
                .map_err(sftp_err)?;
            loop {
                let n = lf.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                rf.write_all(&buf[..n]).await?;
                transferred += n as u64;
                if transferred - last >= SFTP_PROGRESS_STRIDE {
                    last = transferred;
                    emit_progress(app, window, tab_id, transfer_id, transferred, total, false, None);
                }
            }
            rf.shutdown().await?;
        }
        Ok::<u64, AppError>(transferred)
    }
    .await;
    finish_transfer(app, window, tab_id, transfer_id, total, result)
}

/// Cross-connection copy: stream a file from one tab's SFTP session straight
/// into another's, relayed through this process (there's no server-to-server
/// SFTP). Progress is emitted against the destination tab. Must run on the SSH
/// runtime (both sessions' channel drivers live there).
#[allow(clippy::too_many_arguments)]
pub async fn relay(
    slots: SftpSlots,
    app: AppHandle,
    window: String,
    src_tab: u64,
    src_path: String,
    dst_tab: u64,
    dst_path: String,
    transfer_id: u64,
) -> AppResult<()> {
    let src_slot = slots
        .lock()
        .get(&src_tab)
        .cloned()
        .ok_or_else(|| AppError::Ssh("source connection not found".into()))?;
    let dst_slot = slots
        .lock()
        .get(&dst_tab)
        .cloned()
        .ok_or_else(|| AppError::Ssh("destination connection not found".into()))?;
    let src = src_slot
        .lock()
        .await
        .clone()
        .ok_or_else(|| AppError::Ssh("source SFTP not connected".into()))?;
    let dst = dst_slot
        .lock()
        .await
        .clone()
        .ok_or_else(|| AppError::Ssh("destination SFTP not connected".into()))?;

    let total = src.metadata(&src_path).await.ok().and_then(|m| m.size);
    let result = async {
        let mut rf = src.open(&src_path).await.map_err(sftp_err)?;
        let mut wf = dst
            .open_with_flags(
                &dst_path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map_err(sftp_err)?;
        let mut buf = vec![0u8; SFTP_CHUNK];
        let mut transferred = 0u64;
        let mut last = 0u64;
        loop {
            let n = rf.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            wf.write_all(&buf[..n]).await?;
            transferred += n as u64;
            if transferred - last >= SFTP_PROGRESS_STRIDE {
                last = transferred;
                emit_progress(&app, &window, dst_tab, transfer_id, transferred, total, false, None);
            }
        }
        wf.shutdown().await?;
        Ok::<u64, AppError>(transferred)
    }
    .await;
    finish_transfer(&app, &window, dst_tab, transfer_id, total, result)
}

/// Emit the terminal progress event for a transfer and collapse the result
/// to `AppResult<()>` for the command reply.
fn finish_transfer(
    app: &AppHandle,
    window: &str,
    tab_id: u64,
    transfer_id: u64,
    total: Option<u64>,
    result: AppResult<u64>,
) -> AppResult<()> {
    match &result {
        Ok(t) => emit_progress(app, window, tab_id, transfer_id, *t, total, true, None),
        Err(e) => emit_progress(
            app,
            window,
            tab_id,
            transfer_id,
            0,
            total,
            true,
            Some(e.to_string()),
        ),
    }
    result.map(|_| ())
}
