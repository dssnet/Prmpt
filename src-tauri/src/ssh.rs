//! SSH connection pool: bridges russh (async, tokio) with the per-tab sync
//! libghostty-vt loop via crossbeam channels + a tokio mpsc.
//!
//! One authenticated russh transport per saved host (`ConnectionPool` →
//! `PooledConn`), shared by reference-counted *consumers*: a terminal owns a
//! shell channel (`acquire_shell`), a file browser owns an SFTP channel
//! (`acquire_sftp`). The last consumer to leave drops the connection.
//!
//! Per attempt: resolve TCP → russh handshake → verify host key (TOFU) →
//! authenticate. A shell consumer then opens channel + pty + shell and
//! `select!`s inbound channel data (→ `pty_tx` as `PtyEvent::Data`) against
//! outbound `SshIoCmd`s (→ russh `Channel::data`/`window_change`); on a
//! transport drop it re-opens against the reconnected transport, and on close
//! it sends `PtyEvent::Eof`. Reconnect lives on `PooledConn` and fans out to
//! every consumer (shell channels re-open, SFTP slots re-fill).
//!
//! Persistence is the frontend's job: this module emits
//! `ssh:host_key_first_connect`, `ssh:host_key_mismatch`, and
//! `ssh:port_forward_error` events. The frontend persists fingerprints
//! and surfaces errors via the SQL plugin.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
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
        SshConnected, SshHostKeyFirstConnect, SshHostKeyMismatch,
        SshPortForwardError, SshReconnecting,
    },
    tab::{PtyEvent, SftpReq, SshIoCmd},
    SharedRuntime,
};

/// Slot holding the SFTP session for the *current* transport. The pooled
/// connection's supervisor fills it after a successful connect and clears it
/// on disconnect; the long-lived `sftp_service` task reads it per request so
/// it transparently follows reconnects (and rejects requests while
/// disconnected).
pub type SftpSlot = Arc<AsyncMutex<Option<Arc<SftpSession>>>>;

/// One SFTP consumer's command sender + live-session slot. Stored in the
/// `SftpConsumers` registry keyed by **consumer id** (negative panel-scoped
/// ids in the frontend, but a plain `u64` here). The command layer routes
/// `sftp_*` to `sftp_tx`; the cross-connection relay reads `slot` directly.
#[derive(Clone)]
pub struct SftpConsumerHandle {
    pub sftp_tx: mpsc::Sender<SftpReq>,
    pub slot: SftpSlot,
    /// The pooled connection this consumer rides on — kept so `sftp_release`
    /// can drop the consumer (refcount--) and tear the connection down when
    /// it was the last one.
    pub conn: Arc<PooledConn>,
    /// Owning window label, so a window-destroyed cleanup can release every
    /// consumer that window held (file browsers have no backend tab to reap).
    pub window: String,
}

/// Registry of live SFTP consumers, keyed by consumer id. Lets the command
/// layer find a consumer's request channel and lets a cross-connection relay
/// reach two different consumers' SFTP sessions at once.
pub type SftpConsumers =
    Arc<parking_lot::Mutex<std::collections::HashMap<u64, SftpConsumerHandle>>>;

pub fn new_sftp_consumers() -> SftpConsumers {
    Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new()))
}

/// Pending first-connect host-key prompts, keyed by **host id**. A pooled
/// connection handshakes once per host, so the prompt is per-host (not
/// per-tab). `check_server_key` parks a oneshot sender here while the user
/// looks at the fingerprint; the `ssh_confirm_host_key` command resolves it
/// (managed as Tauri state).
pub type HostKeyPrompts =
    Arc<parking_lot::Mutex<std::collections::HashMap<i64, tokio::sync::oneshot::Sender<bool>>>>;

pub fn new_host_key_prompts() -> HostKeyPrompts {
    Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new()))
}

/// How long the first-connect prompt waits for the user before treating the
/// key as rejected. Kept at sshd's default LoginGraceTime — the server drops
/// the half-finished handshake after that anyway.
const HOST_KEY_PROMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Chunk size for streamed SFTP transfers.
const SFTP_CHUNK: usize = 64 * 1024;
/// Emit a progress event at most this often (bytes) to avoid flooding the
/// webview on large transfers; plus one final emit on completion.
const SFTP_PROGRESS_STRIDE: u64 = 512 * 1024;

/// Time-based progress floor for multi-entry operations (directory
/// uploads/downloads/deletes): the byte stride alone can starve the UI when
/// per-entry round trips dominate (many small files), so also emit on a clock.
const SFTP_PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

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
    /// Per-host opt-in for SFTP-only connections: when true, never open a
    /// shell channel (the target may be a `ForceCommand internal-sftp`
    /// account that rejects shells) — SFTP becomes mandatory instead.
    #[serde(default)]
    pub disable_ssh: bool,
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
                // TOFU first connect: don't trust silently — show the
                // fingerprint and block the handshake on the user's verdict.
                // Rejecting (or timing out) makes russh abort the connection
                // before any credentials are sent.
                use tauri::Manager;
                let prompts = self.app.state::<crate::ssh::HostKeyPrompts>();
                let (tx, rx) = tokio::sync::oneshot::channel();
                prompts.lock().insert(self.host_id, tx);
                // Broadcast: a pooled connection may back consumers in more
                // than one window; whichever shows the modal can confirm
                // (the prompt is keyed by host id).
                let _ = self.app.emit(
                    "ssh:host_key_first_connect",
                    SshHostKeyFirstConnect {
                        tab_id: 0,
                        host_id: self.host_id,
                        fingerprint: fp.clone(),
                        algorithm: alg.clone(),
                    },
                );
                let accepted = matches!(
                    tokio::time::timeout(HOST_KEY_PROMPT_TIMEOUT, rx).await,
                    Ok(Ok(true))
                );
                prompts.lock().remove(&self.host_id);
                if accepted {
                    self.state.lock().captured_fp = Some((fp, alg));
                    Ok(true)
                } else {
                    self.state.lock().host_key_rejected = true;
                    Ok(false)
                }
            }
            Some(stored) if stored == &fp => Ok(true),
            Some(stored) => {
                let _ = self.app.emit(
                    "ssh:host_key_mismatch",
                    SshHostKeyMismatch {
                        tab_id: 0,
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

// ---------- session lifecycle (see "connection pool" section below) ----------

/// Why a shell channel's drive loop stopped. Decides whether the pooled
/// connection reconnects (and the consumer re-opens its channel) or the
/// consumer goes away.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SessionOutcome {
    /// Consumer is being closed locally (tab closed / VT thread gone).
    LocalClose,
    /// Remote shell exited cleanly (`exit`/logout, exit status/signal).
    RemoteExit,
    /// Transport vanished unexpectedly — candidate for auto-reconnect.
    Dropped,
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

// ---------- connection pool ----------
//
// One authenticated russh transport per saved host, shared by independent
// reference-counted *consumers*: a terminal owns a shell channel, a file
// browser owns an SFTP channel. The last consumer to leave drops the
// connection. Reconnect lives on the connection and fans out to every
// consumer: a shell channel that dies re-opens against the fresh transport,
// and every SFTP slot is re-filled.

/// A live transport handle + the generation it belongs to. A consumer compares
/// the generation it last saw against the connection's current one to tell a
/// transient channel error apart from a transport it already knows is stale.
#[derive(Clone)]
struct TransportRef {
    handle: Arc<AsyncMutex<Handle<ClientHandler>>>,
    generation: u64,
}

/// One registered SFTP consumer, kept on the connection so every (re)connect
/// re-opens its subsystem and a shell drop can clear its slot. Cloneable so
/// `on_connected` can iterate a snapshot without holding the registry lock
/// across awaits.
#[derive(Clone)]
struct SftpReg {
    slot: SftpSlot,
    /// Latches once the user actually browses a "Shell only" (lazy) host, so
    /// later reconnects re-open the subsystem eagerly.
    wanted: Arc<AtomicBool>,
    lazy: bool,
    /// Window that owns this consumer, for the `sftp:availability` emit.
    window: String,
}

/// Mutable transport state for a pooled connection, behind one async mutex.
struct TransportState {
    handle: Option<Arc<AsyncMutex<Handle<ClientHandler>>>>,
    /// Bumped on every successful (re)connect.
    generation: u64,
    /// Known host fingerprint; updated in place after a TOFU accept so a key
    /// change is still caught on reconnect.
    stored_fp: Option<String>,
    forward_tasks: Vec<JoinHandle<()>>,
    /// True once a transport was ever established — distinguishes "first
    /// connect failed (surface the modal, give up)" from "reconnect".
    ever_connected: bool,
    /// True between a drop and the next successful connect (dedups the
    /// reconnecting/connected emits).
    reconnecting: bool,
    /// Set when the connection is being abandoned (last consumer left, first
    /// connect failed, or host key rejected) — stops all (re)connect attempts.
    shutdown: bool,
    backoff: u64,
}

/// A shared SSH connection for one saved host. See the section comment.
pub struct PooledConn {
    host_id: i64,
    app: AppHandle,
    /// Auth + forward config captured at first acquire.
    config: Mutex<SshConnectConfig>,
    state: AsyncMutex<TransportState>,
    /// Serializes (re)connect attempts; held across the connect + backoff.
    connect_lock: AsyncMutex<()>,
    /// Live SFTP consumers, keyed by consumer id.
    sftp_regs: Mutex<HashMap<u64, SftpReg>>,
    /// Number of live consumers (shells + browsers). Drops to 0 → teardown.
    refcount: AtomicUsize,
    /// Sync mirror of `state.shutdown` so the (sync) pool lock can skip a dead
    /// connection without awaiting the state mutex.
    dead: AtomicBool,
}

impl PooledConn {
    fn new(app: AppHandle, config: SshConnectConfig) -> Self {
        let stored_fp = config.stored_fingerprint.clone();
        Self {
            host_id: config.host_id,
            app,
            config: Mutex::new(config),
            state: AsyncMutex::new(TransportState {
                handle: None,
                generation: 0,
                stored_fp,
                forward_tasks: Vec::new(),
                ever_connected: false,
                reconnecting: false,
                shutdown: false,
                backoff: 1,
            }),
            connect_lock: AsyncMutex::new(()),
            sftp_regs: Mutex::new(HashMap::new()),
            refcount: AtomicUsize::new(0),
            dead: AtomicBool::new(false),
        }
    }

    async fn current_session(&self) -> Option<Arc<AsyncMutex<Handle<ClientHandler>>>> {
        self.state.lock().await.handle.clone()
    }

    /// One connect+auth attempt. `Ok(Some)` connected; `Ok(None)` host key
    /// rejected (never retry); `Err` other failure (caller decides retry).
    async fn connect_once(&self) -> AppResult<Option<Arc<AsyncMutex<Handle<ClientHandler>>>>> {
        let config = self.config.lock().clone();
        let stored_fp = self.state.lock().await.stored_fp.clone();

        let russh_config = Arc::new(client::Config {
            inactivity_timeout: None,
            ..Default::default()
        });
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
            stored_fp,
            app: self.app.clone(),
            host_id: self.host_id,
            state: state.clone(),
        };

        let addr = format!("{}:{}", config.hostname, config.port);
        let mut session = client::connect(russh_config, &addr, handler)
            .await
            .map_err(|e| AppError::Ssh(format!("connect: {e}")))?;
        let auth_ok = authenticate(&mut session, &config.username, &config.auth).await?;
        if !auth_ok {
            if state.lock().host_key_rejected {
                let _ = session.disconnect(Disconnect::ByApplication, "", "").await;
                return Ok(None);
            }
            return Err(AppError::Ssh(
                "authentication failed (check password / key / agent identities)".into(),
            ));
        }
        // TOFU: remember the now-confirmed fingerprint so a later reconnect
        // still detects a key change. Take it out of the (sync) handler lock
        // *before* awaiting the state mutex — a parking_lot guard isn't Send.
        let captured = state.lock().captured_fp.take();
        if let Some((fp, _alg)) = captured {
            self.state.lock().await.stored_fp = Some(fp);
        }
        Ok(Some(Arc::new(AsyncMutex::new(session))))
    }

    /// Return a live transport, (re)connecting if needed. Serialized so
    /// concurrent consumers don't dial in parallel; the first to arrive
    /// connects, the rest wait then reuse. `Err` means give up (first connect
    /// failed, host key rejected, or the connection is shutting down).
    async fn await_session(self: &Arc<Self>) -> AppResult<TransportRef> {
        {
            let st = self.state.lock().await;
            if let Some(h) = &st.handle {
                return Ok(TransportRef { handle: h.clone(), generation: st.generation });
            }
            if st.shutdown {
                return Err(AppError::Ssh("connection closed".into()));
            }
        }
        let _guard = self.connect_lock.lock().await;
        {
            let st = self.state.lock().await;
            if let Some(h) = &st.handle {
                return Ok(TransportRef { handle: h.clone(), generation: st.generation });
            }
            if st.shutdown {
                return Err(AppError::Ssh("connection closed".into()));
            }
        }
        loop {
            if self.state.lock().await.shutdown {
                return Err(AppError::Ssh("connection closed".into()));
            }
            match self.connect_once().await {
                Ok(Some(session)) => {
                    let gen = {
                        let mut st = self.state.lock().await;
                        st.generation += 1;
                        st.handle = Some(session.clone());
                        st.reconnecting = false;
                        st.ever_connected = true;
                        st.backoff = 1;
                        st.generation
                    };
                    self.on_connected(&session, gen).await;
                    return Ok(TransportRef { handle: session, generation: gen });
                }
                Ok(None) => {
                    self.dead.store(true, Ordering::SeqCst);
                    self.state.lock().await.shutdown = true;
                    return Err(AppError::Ssh("host key changed — see dialog".into()));
                }
                Err(e) => {
                    let ever = self.state.lock().await.ever_connected;
                    if !ever {
                        let raw = e.to_string();
                        let (label, hostname) = {
                            let c = self.config.lock();
                            (c.label.clone(), c.hostname.clone())
                        };
                        let _ = self.app.emit(
                            "ssh:connect_error",
                            SshConnectError {
                                tab_id: 0,
                                host_id: self.host_id,
                                host_label: label,
                                hostname,
                                kind: classify_connect_error(&raw).to_string(),
                                message: raw,
                            },
                        );
                        self.dead.store(true, Ordering::SeqCst);
                        self.state.lock().await.shutdown = true;
                        return Err(e);
                    }
                    // Reconnect attempt failed — back off and retry, staying
                    // responsive to shutdown.
                    let backoff = {
                        let mut st = self.state.lock().await;
                        let b = st.backoff;
                        st.backoff = (st.backoff * 2).min(30);
                        b
                    };
                    for _ in 0..backoff {
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        if self.state.lock().await.shutdown {
                            return Err(AppError::Ssh("connection closed".into()));
                        }
                    }
                }
            }
        }
    }

    /// A consumer observed its channel die. If the dropped transport is still
    /// the current one, clear it (so the next `await_session` reconnects),
    /// abort forwards, clear every SFTP slot, and announce "reconnecting".
    async fn mark_dropped(self: &Arc<Self>, gen: u64) {
        {
            let mut st = self.state.lock().await;
            if st.shutdown || st.generation != gen || st.handle.is_none() {
                return;
            }
            st.handle = None;
            st.reconnecting = true;
            for t in st.forward_tasks.drain(..) {
                t.abort();
            }
        }
        let slots: Vec<SftpSlot> = self
            .sftp_regs
            .lock()
            .values()
            .map(|r| r.slot.clone())
            .collect();
        for slot in slots {
            *slot.lock().await = None;
        }
        let label = self.config.lock().label.clone();
        let _ = self.app.emit(
            "ssh:reconnecting",
            SshReconnecting {
                tab_id: 0,
                host_id: self.host_id,
                host_label: label,
            },
        );
    }

    /// Runs once per successful (re)connect: (re)spawn port forwards, re-open
    /// every registered SFTP subsystem (skipping a lazy host nobody has browsed
    /// yet), and announce per-consumer availability + connection "connected".
    async fn on_connected(
        self: &Arc<Self>,
        session: &Arc<AsyncMutex<Handle<ClientHandler>>>,
        _gen: u64,
    ) {
        let config = self.config.lock().clone();
        let mut forward_tasks = Vec::new();
        for fw in config.forwards.clone() {
            let handle = session.clone();
            let app = self.app.clone();
            let host_id = self.host_id;
            let fw_id = fw.id;
            forward_tasks.push(tokio::spawn(async move {
                if let Err(e) = run_forward(handle, fw).await {
                    let _ = app.emit(
                        "ssh:port_forward_error",
                        SshPortForwardError {
                            tab_id: 0,
                            host_id,
                            forward_id: fw_id,
                            message: e.to_string(),
                        },
                    );
                }
            }));
        }
        self.state.lock().await.forward_tasks = forward_tasks;

        let regs: Vec<(u64, SftpReg)> = self
            .sftp_regs
            .lock()
            .iter()
            .map(|(id, r)| (*id, r.clone()))
            .collect();
        for (id, reg) in regs {
            let lazy_deferred = reg.lazy && !reg.wanted.load(Ordering::Relaxed);
            let sftp = if lazy_deferred {
                None
            } else {
                open_sftp(session).await
            };
            let available = sftp.is_some();
            *reg.slot.lock().await = sftp;
            let _ = self.app.emit_to(
                EventTarget::webview_window(&reg.window),
                "sftp:availability",
                SftpAvailability { tab_id: id, available },
            );
        }

        let _ = self.app.emit(
            "ssh:connected",
            SshConnected {
                tab_id: 0,
                host_id: self.host_id,
                host_label: config.label.clone(),
            },
        );
    }

    /// Open the SFTP subsystem for one already-registered consumer against the
    /// live transport, if it isn't open yet (and isn't a lazy host still
    /// awaiting its first browse). Used when a consumer joins a host that is
    /// *already* connected — `on_connected` only runs on a fresh (re)connect.
    async fn ensure_sftp_open(self: &Arc<Self>, consumer_id: u64) {
        let reg = self.sftp_regs.lock().get(&consumer_id).cloned();
        let Some(reg) = reg else {
            return;
        };
        if reg.lazy && !reg.wanted.load(Ordering::Relaxed) {
            return;
        }
        if reg.slot.lock().await.is_some() {
            return;
        }
        let Some(session) = self.current_session().await else {
            return;
        };
        let sftp = open_sftp(&session).await;
        let available = sftp.is_some();
        *reg.slot.lock().await = sftp;
        let _ = self.app.emit_to(
            EventTarget::webview_window(&reg.window),
            "sftp:availability",
            SftpAvailability {
                tab_id: consumer_id,
                available,
            },
        );
    }

    /// Disconnect the transport and stop all activity. Called once, after the
    /// last consumer leaves.
    async fn teardown(&self) {
        let mut st = self.state.lock().await;
        st.shutdown = true;
        for t in st.forward_tasks.drain(..) {
            t.abort();
        }
        let handle = st.handle.take();
        drop(st);
        if let Some(h) = handle {
            let _ = h.lock().await.disconnect(Disconnect::ByApplication, "", "").await;
        }
    }
}

/// Periodic transport-liveness poll for one connection. Detects a drop even
/// when no shell channel is driving I/O (a file-browser-only connection), and
/// proactively reconnects so an idle SFTP-only host comes back on its own.
/// russh 0.49 has no async "closed" future, hence the poll. Exits on teardown.
async fn conn_health_check(conn: Arc<PooledConn>) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(2));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let (shutdown, handle, gen, reconnecting) = {
            let st = conn.state.lock().await;
            (st.shutdown, st.handle.clone(), st.generation, st.reconnecting)
        };
        if shutdown {
            break;
        }
        match handle {
            Some(h) => {
                if h.lock().await.is_closed() {
                    conn.mark_dropped(gen).await;
                    let _ = conn.await_session().await;
                }
            }
            None => {
                // Mid-reconnect with no shell consumer driving it — keep the
                // SFTP-only case progressing.
                if reconnecting {
                    let _ = conn.await_session().await;
                }
            }
        }
    }
}

/// Open a shell channel (pty + shell) on an established transport.
async fn open_shell_channel(
    session: &Arc<AsyncMutex<Handle<ClientHandler>>>,
    cols: u16,
    rows: u16,
) -> AppResult<Channel<client::Msg>> {
    let ch = session
        .lock()
        .await
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("channel open: {e}")))?;
    ch.request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await
        .map_err(|e| AppError::Ssh(format!("request pty: {e}")))?;
    ch.request_shell(false)
        .await
        .map_err(|e| AppError::Ssh(format!("request shell: {e}")))?;
    Ok(ch)
}

/// Drain a shell consumer's outbound queue while (re)connecting: track the
/// latest size from Resize, drop queued Write (the old shell is gone), and
/// return when Close arrives / the sender is dropped so the consumer stops.
async fn drain_until_close(
    out_rx: &mut mpsc::Receiver<SshIoCmd>,
    cols: &mut u16,
    rows: &mut u16,
) {
    loop {
        match out_rx.recv().await {
            Some(SshIoCmd::Close) | None => return,
            Some(SshIoCmd::Resize { cols: c, rows: r, .. }) => {
                *cols = c;
                *rows = r;
            }
            Some(SshIoCmd::Write(_)) => {}
        }
    }
}

/// A terminal's shell consumer. Acquires a channel from the pooled connection,
/// drives its I/O, and on a transport drop re-acquires against the reconnected
/// transport. Banners mirror the old per-session UX. Releases the consumer
/// (refcount--) when the tab closes or the remote shell exits.
#[allow(clippy::too_many_arguments)]
async fn run_shell_consumer(
    pool: Arc<ConnectionPool>,
    conn: Arc<PooledConn>,
    consumer_id: u64,
    pty_tx: crossbeam_channel::Sender<PtyEvent>,
    mut out_rx: mpsc::Receiver<SshIoCmd>,
    mut cols: u16,
    mut rows: u16,
) {
    let (label, addr) = {
        let c = conn.config.lock();
        (c.label.clone(), format!("{}:{}", c.hostname, c.port))
    };
    let mut first = true;
    loop {
        if first {
            let _ = pty_tx.send(PtyEvent::Data(
                format!(
                    "\r\n\x1b[36m\u{2192} connecting to {label} ({addr})\u{2026}\x1b[0m\r\n"
                )
                .into_bytes(),
            ));
        }
        // Stay cancellable while (re)connecting: a Close during a backoff must
        // tear the consumer down instead of waiting out the retry.
        let sess = tokio::select! {
            biased;
            _ = drain_until_close(&mut out_rx, &mut cols, &mut rows) => break,
            s = conn.await_session() => match s {
                Ok(s) => s,
                Err(e) => {
                    let _ = pty_tx.send(PtyEvent::Data(
                        format!("\r\n\x1b[31mSSH error:\x1b[0m {e}\r\n").into_bytes(),
                    ));
                    break;
                }
            },
        };
        let mut channel = match open_shell_channel(&sess.handle, cols, rows).await {
            Ok(c) => c,
            Err(_) => {
                conn.mark_dropped(sess.generation).await;
                first = false;
                continue;
            }
        };
        let banner = if first {
            "\r\n\x1b[32m\u{2713} connected.\x1b[0m\r\n"
        } else {
            "\r\n\x1b[32m\u{2713} reconnected.\x1b[0m\r\n"
        };
        let _ = pty_tx.send(PtyEvent::Data(banner.as_bytes().to_vec()));
        first = false;
        match drive_channel_loop(&mut channel, &pty_tx, &mut out_rx, &mut cols, &mut rows).await {
            SessionOutcome::LocalClose | SessionOutcome::RemoteExit => break,
            SessionOutcome::Dropped => {
                let _ = pty_tx.send(PtyEvent::Data(
                    "\r\n\x1b[33m\u{26a0} connection lost \u{2014} reconnecting\u{2026} (Ctrl+C cancels)\x1b[0m\r\n"
                        .as_bytes()
                        .to_vec(),
                ));
                conn.mark_dropped(sess.generation).await;
            }
        }
    }
    let _ = pty_tx.send(PtyEvent::Eof);
    pool.release_conn(&conn, consumer_id);
}

/// Tauri-managed handle to the pool.
pub type SharedPool = Arc<ConnectionPool>;

/// Per-host connection pool (Tauri managed state). See the section comment.
pub struct ConnectionPool {
    rt: SharedRuntime,
    inner: Mutex<HashMap<i64, Arc<PooledConn>>>,
    next_consumer: AtomicU64,
}

impl ConnectionPool {
    pub fn new(rt: SharedRuntime) -> Arc<Self> {
        Arc::new(Self {
            rt,
            inner: Mutex::new(HashMap::new()),
            next_consumer: AtomicU64::new(1),
        })
    }

    fn alloc_consumer_id(&self) -> u64 {
        self.next_consumer.fetch_add(1, Ordering::SeqCst)
    }

    /// Reuse the host's connection or create one. Increments the refcount under
    /// the pool lock (so it can't race a teardown). Spawns the health task for
    /// a freshly created connection.
    fn get_or_create(self: &Arc<Self>, app: &AppHandle, config: &SshConnectConfig) -> Arc<PooledConn> {
        let mut map = self.inner.lock();
        if let Some(c) = map.get(&config.host_id) {
            if !c.dead.load(Ordering::SeqCst) {
                c.refcount.fetch_add(1, Ordering::SeqCst);
                return c.clone();
            }
        }
        let conn = Arc::new(PooledConn::new(app.clone(), config.clone()));
        conn.refcount.store(1, Ordering::SeqCst);
        map.insert(config.host_id, conn.clone());
        self.rt.spawn(conn_health_check(conn.clone()));
        conn
    }

    /// Attach a terminal: open a pooled shell channel feeding `pty_tx`, return
    /// the outbound command channel for the tab thread.
    pub fn acquire_shell(
        self: &Arc<Self>,
        app: &AppHandle,
        config: SshConnectConfig,
        pty_tx: crossbeam_channel::Sender<PtyEvent>,
        cols: u16,
        rows: u16,
    ) -> mpsc::Sender<SshIoCmd> {
        let (out_tx, out_rx) = mpsc::channel::<SshIoCmd>(128);
        let conn = self.get_or_create(app, &config);
        let consumer_id = self.alloc_consumer_id();
        let pool = self.clone();
        self.rt.spawn(run_shell_consumer(
            pool, conn, consumer_id, pty_tx, out_rx, cols, rows,
        ));
        out_tx
    }

    /// Attach a file browser: register an SFTP consumer, start its service
    /// task, and kick an initial connect (so the host-key prompt + availability
    /// fire). Returns the consumer id the frontend routes `sftp_*` by.
    pub fn acquire_sftp(
        self: &Arc<Self>,
        app: &AppHandle,
        window: String,
        config: SshConnectConfig,
        consumers: &SftpConsumers,
    ) -> u64 {
        let conn = self.get_or_create(app, &config);
        let consumer_id = self.alloc_consumer_id();
        let (sftp_tx, sftp_rx) = mpsc::channel::<SftpReq>(32);
        let slot: SftpSlot = Arc::new(AsyncMutex::new(None));
        let wanted = Arc::new(AtomicBool::new(false));
        // "Shell only" hosts defer the subsystem to the first browse.
        let lazy = config.disable_sftp && !config.disable_ssh;
        conn.sftp_regs.lock().insert(
            consumer_id,
            SftpReg {
                slot: slot.clone(),
                wanted: wanted.clone(),
                lazy,
                window: window.clone(),
            },
        );
        consumers.lock().insert(
            consumer_id,
            SftpConsumerHandle {
                sftp_tx,
                slot: slot.clone(),
                conn: conn.clone(),
                window: window.clone(),
            },
        );
        self.rt.spawn(sftp_service(
            sftp_rx,
            slot,
            conn.clone(),
            wanted,
            lazy,
            app.clone(),
            window,
            consumer_id,
        ));
        // Establish the transport so the prompt + availability happen even
        // before the first browse. A fresh (re)connect opens this reg via
        // `on_connected`; if the host was already connected, open it directly.
        // A lazy ("Shell only") reg waits for the first browse either way.
        let conn2 = conn.clone();
        self.rt.spawn(async move {
            if conn2.await_session().await.is_ok() {
                conn2.ensure_sftp_open(consumer_id).await;
            }
        });
        consumer_id
    }

    /// Release every SFTP consumer a (now-destroyed) window held. File
    /// browsers have no backend tab for the window-Destroyed handler to reap,
    /// so without this their consumers — and the pooled connections they keep
    /// alive — would leak until app exit.
    pub fn release_window(self: &Arc<Self>, consumers: &SftpConsumers, window: &str) {
        let dropped: Vec<(u64, Arc<PooledConn>)> = {
            let mut map = consumers.lock();
            let ids: Vec<u64> = map
                .iter()
                .filter(|(_, h)| h.window == window)
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter()
                .filter_map(|id| map.remove(&id).map(|h| (id, h.conn)))
                .collect()
        };
        for (id, conn) in dropped {
            self.release_conn(&conn, id);
        }
    }

    /// Drop one consumer (refcount--). Tears the connection down — and removes
    /// it from the pool — when the last consumer leaves. Matching the mapped
    /// connection by pointer keeps a stale entry from being clobbered after a
    /// dead connection was already replaced.
    pub fn release_conn(self: &Arc<Self>, conn: &Arc<PooledConn>, consumer_id: u64) {
        conn.sftp_regs.lock().remove(&consumer_id);
        let teardown = {
            let mut map = self.inner.lock();
            let prev = conn.refcount.fetch_sub(1, Ordering::SeqCst);
            if prev <= 1 {
                conn.dead.store(true, Ordering::SeqCst);
                if let Some(existing) = map.get(&conn.host_id) {
                    if Arc::ptr_eq(existing, conn) {
                        map.remove(&conn.host_id);
                    }
                }
                true
            } else {
                false
            }
        };
        if teardown {
            let conn = conn.clone();
            self.rt.spawn(async move {
                conn.teardown().await;
            });
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
/// (fast, and naturally serialized); transfers and directory deletes are
/// spawned so a big one doesn't block browsing.
///
/// For `lazy` ("Shell only") hosts the subsystem isn't opened at connect; the
/// first request ensures the transport is up (via the pooled `conn`), latches
/// `sftp_wanted` (so reconnects re-open eagerly), opens it on demand, and
/// announces availability. `tab_id` here is the SFTP consumer id.
#[allow(clippy::too_many_arguments)]
async fn sftp_service(
    mut rx: mpsc::Receiver<SftpReq>,
    slot: SftpSlot,
    conn: Arc<PooledConn>,
    sftp_wanted: Arc<AtomicBool>,
    lazy: bool,
    app: AppHandle,
    window: String,
    tab_id: u64,
) {
    while let Some(req) = rx.recv().await {
        let mut current = slot.lock().await.clone();
        // On-demand open for lazy hosts: the first browse latches `wanted` and
        // ensures the transport is up. If the connection had to (re)connect,
        // `on_connected` already opened the subsystem (wanted is now set), so
        // re-read the slot; otherwise open it here against the live transport.
        // Serialized request handling means no two opens race within a consumer.
        if current.is_none() && lazy {
            sftp_wanted.store(true, Ordering::Relaxed);
            if conn.await_session().await.is_ok() {
                current = slot.lock().await.clone();
                if current.is_none() {
                    if let Some(session) = conn.current_session().await {
                        if let Some(opened) = open_sftp(&session).await {
                            *slot.lock().await = Some(opened.clone());
                            let _ = app.emit_to(
                                EventTarget::webview_window(&window),
                                "sftp:availability",
                                SftpAvailability { tab_id, available: true },
                            );
                            current = Some(opened);
                        }
                    }
                }
            }
        }
        let Some(sftp) = current else {
            reject_sftp(req, "SFTP is not connected");
            continue;
        };
        match req {
            SftpReq::Download { .. }
            | SftpReq::Upload { .. }
            | SftpReq::Remove { is_dir: true, .. } => {
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
        SftpReq::Remove { path, reply, .. } => {
            // Directory removes are dispatched to a spawned task by
            // `sftp_service` (long-running, emit progress); only files
            // arrive here.
            let _ = reply.send(sftp.remove_file(path).await.map_err(sftp_err));
        }
        // Transfers (and dir removes) are dispatched separately by `sftp_service`.
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

/// Recursive directory delete. SFTP's `RMDIR` only succeeds on an empty
/// directory (a non-empty one fails with the generic SSH_FX_FAILURE), so walk
/// the tree first: remove files as we go, collect directories, then remove
/// those children-first. Symlinks are removed as files (never followed), so a
/// link to a directory outside the tree can't widen the delete.
///
/// Progress is emitted as a count of removed entries; `total` stays `None`
/// (the tree isn't pre-walked just to show a percentage).
async fn sftp_remove_dir_all(
    sftp: &SftpSession,
    app: &AppHandle,
    window: &str,
    tab_id: u64,
    transfer_id: u64,
    dir: &str,
) -> AppResult<()> {
    let result = async {
        let mut removed = 0u64;
        let mut last_emit = std::time::Instant::now();
        // Iterative DFS — async recursion would need boxing.
        let mut stack = vec![dir.to_string()];
        let mut dirs = Vec::new();
        while let Some(d) = stack.pop() {
            for entry in sftp.read_dir(&d).await.map_err(sftp_err)? {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let path = join_remote(&d, &name);
                let md = entry.metadata();
                if md.is_dir() && !md.is_symlink() {
                    stack.push(path);
                } else {
                    sftp.remove_file(path).await.map_err(sftp_err)?;
                    removed += 1;
                    if last_emit.elapsed() >= SFTP_PROGRESS_INTERVAL {
                        last_emit = std::time::Instant::now();
                        emit_progress(app, window, tab_id, transfer_id, removed, None, false, None);
                    }
                }
            }
            dirs.push(d);
        }
        // `dirs` is ordered parents-before-children; remove in reverse.
        for d in dirs.into_iter().rev() {
            sftp.remove_dir(d).await.map_err(sftp_err)?;
            removed += 1;
            if last_emit.elapsed() >= SFTP_PROGRESS_INTERVAL {
                last_emit = std::time::Instant::now();
                emit_progress(app, window, tab_id, transfer_id, removed, None, false, None);
            }
        }
        Ok::<u64, AppError>(removed)
    }
    .await;
    finish_transfer(app, window, tab_id, transfer_id, None, result)
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
        SftpReq::Remove {
            path,
            transfer_id,
            reply,
            ..
        } => {
            let r = sftp_remove_dir_all(&sftp, &app, &window, tab_id, transfer_id, &path).await;
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
    let md = sftp.metadata(remote).await.ok();
    if md.as_ref().map(|m| m.is_dir()).unwrap_or(false) {
        return sftp_download_dir(sftp, app, window, tab_id, transfer_id, remote, local).await;
    }
    let total = md.and_then(|m| m.size);
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
    // Hand the UI the byte total right away so it can show a percentage even
    // before the first stride of payload moves.
    emit_progress(app, window, tab_id, transfer_id, 0, total, false, None);
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
        let mut last_emit = std::time::Instant::now();
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
                    last_emit = std::time::Instant::now();
                    emit_progress(app, window, tab_id, transfer_id, transferred, total, false, None);
                }
            }
            rf.shutdown().await?;
            // Per-entry round trips dominate for trees of small files; keep
            // the indicator moving even when the byte stride hasn't tripped.
            if last_emit.elapsed() >= SFTP_PROGRESS_INTERVAL {
                last_emit = std::time::Instant::now();
                emit_progress(app, window, tab_id, transfer_id, transferred, total, false, None);
            }
        }
        Ok::<u64, AppError>(transferred)
    }
    .await;
    finish_transfer(app, window, tab_id, transfer_id, total, result)
}

/// Walk a remote directory tree breadth-first via SFTP. Returns the
/// subdirectories as paths relative to `root` (parents always listed before
/// their children, so they can be created in order), the regular files as
/// `(relative path, absolute remote path)` pairs, and the total byte count.
async fn collect_remote_tree(
    sftp: &SftpSession,
    root: &str,
) -> AppResult<(
    Vec<std::path::PathBuf>,
    Vec<(std::path::PathBuf, String)>,
    u64,
)> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    let mut files: Vec<(std::path::PathBuf, String)> = Vec::new();
    let mut total = 0u64;
    // Queue of (absolute remote dir, relative path from root).
    let mut queue = vec![(root.to_string(), std::path::PathBuf::new())];
    let mut i = 0;
    while i < queue.len() {
        let (dir, rel) = queue[i].clone();
        i += 1;
        let rd = sftp.read_dir(&dir).await.map_err(sftp_err)?;
        for entry in rd {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let md = entry.metadata();
            let abs = join_remote(&dir, &name);
            let child_rel = rel.join(&name);
            if md.is_dir() {
                dirs.push(child_rel.clone());
                queue.push((abs, child_rel));
            } else if !md.is_symlink() {
                total += md.size.unwrap_or(0);
                files.push((child_rel, abs));
            }
            // Symlinks and other special files are skipped.
        }
    }
    Ok((dirs, files, total))
}

/// Recursively download a remote directory: create the destination tree (best
/// effort — existing dirs are fine) then stream every file, emitting a single
/// transfer's progress against the summed byte total.
#[allow(clippy::too_many_arguments)]
async fn sftp_download_dir(
    sftp: &SftpSession,
    app: &AppHandle,
    window: &str,
    tab_id: u64,
    transfer_id: u64,
    remote: &str,
    local: &std::path::Path,
) -> AppResult<()> {
    let (dirs, files, bytes) = match collect_remote_tree(sftp, remote).await {
        Ok(t) => t,
        Err(e) => return finish_transfer(app, window, tab_id, transfer_id, None, Err(e)),
    };
    let total = Some(bytes);
    // Hand the UI the byte total right away so it can show a percentage even
    // before the first stride of payload moves.
    emit_progress(app, window, tab_id, transfer_id, 0, total, false, None);
    let result = async {
        // Create the destination root and every subdirectory (parents first).
        tokio::fs::create_dir_all(local).await?;
        for rel in &dirs {
            tokio::fs::create_dir_all(local.join(rel)).await?;
        }
        let mut buf = vec![0u8; SFTP_CHUNK];
        let mut transferred = 0u64;
        let mut last = 0u64;
        let mut last_emit = std::time::Instant::now();
        for (rel, rpath) in &files {
            let mut rf = sftp.open(rpath).await.map_err(sftp_err)?;
            let mut lf = tokio::fs::File::create(local.join(rel)).await?;
            loop {
                let n = rf.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                lf.write_all(&buf[..n]).await?;
                transferred += n as u64;
                if transferred - last >= SFTP_PROGRESS_STRIDE {
                    last = transferred;
                    last_emit = std::time::Instant::now();
                    emit_progress(app, window, tab_id, transfer_id, transferred, total, false, None);
                }
            }
            lf.flush().await?;
            // Per-entry round trips dominate for trees of small files; keep
            // the indicator moving even when the byte stride hasn't tripped.
            if last_emit.elapsed() >= SFTP_PROGRESS_INTERVAL {
                last_emit = std::time::Instant::now();
                emit_progress(app, window, tab_id, transfer_id, transferred, total, false, None);
            }
        }
        Ok::<u64, AppError>(transferred)
    }
    .await;
    finish_transfer(app, window, tab_id, transfer_id, total, result)
}

/// Cross-connection copy: stream a file or directory tree from one consumer's
/// SFTP session straight into another's, relayed through this process (there's
/// no server-to-server SFTP). Progress is emitted against the destination
/// consumer. Must run on the SSH runtime (both consumers' tasks live there).
/// `src_tab`/`dst_tab` are SFTP consumer ids.
#[allow(clippy::too_many_arguments)]
pub async fn relay(
    consumers: SftpConsumers,
    app: AppHandle,
    window: String,
    src_tab: u64,
    src_path: String,
    dst_tab: u64,
    dst_path: String,
    transfer_id: u64,
) -> AppResult<()> {
    let src_slot = consumers
        .lock()
        .get(&src_tab)
        .map(|h| h.slot.clone())
        .ok_or_else(|| AppError::Ssh("source connection not found".into()))?;
    let dst_slot = consumers
        .lock()
        .get(&dst_tab)
        .map(|h| h.slot.clone())
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

    let md = src.metadata(&src_path).await.ok();
    if md.as_ref().map(|m| m.is_dir()).unwrap_or(false) {
        return relay_dir(
            &src,
            &dst,
            &app,
            &window,
            dst_tab,
            transfer_id,
            &src_path,
            &dst_path,
        )
        .await;
    }
    let total = md.and_then(|m| m.size);
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

/// Recursively relay a directory between two connections: mirror the tree on
/// the destination (best effort — existing dirs are fine) then stream every
/// file, emitting a single transfer's progress against the summed byte total.
/// Symlinks and special files are skipped, same as directory download/upload.
#[allow(clippy::too_many_arguments)]
async fn relay_dir(
    src: &SftpSession,
    dst: &SftpSession,
    app: &AppHandle,
    window: &str,
    dst_tab: u64,
    transfer_id: u64,
    src_path: &str,
    dst_path: &str,
) -> AppResult<()> {
    let (dirs, files, bytes) = match collect_remote_tree(src, src_path).await {
        Ok(t) => t,
        Err(e) => return finish_transfer(app, window, dst_tab, transfer_id, None, Err(e)),
    };
    let total = Some(bytes);
    // Hand the UI the byte total right away so it can show a percentage even
    // before the first stride of payload moves.
    emit_progress(app, window, dst_tab, transfer_id, 0, total, false, None);
    let result = async {
        // Create the destination root and every subdirectory (parents first).
        // `create_dir` errors are ignored: a dir that already exists is fine,
        // and a genuine failure will surface when we try to write a file into it.
        let _ = dst.create_dir(dst_path).await;
        for rel in &dirs {
            let _ = dst.create_dir(&remote_join(dst_path, rel)).await;
        }
        let mut buf = vec![0u8; SFTP_CHUNK];
        let mut transferred = 0u64;
        let mut last = 0u64;
        let mut last_emit = std::time::Instant::now();
        for (rel, rpath) in &files {
            let mut rf = src.open(rpath).await.map_err(sftp_err)?;
            let mut wf = dst
                .open_with_flags(
                    &remote_join(dst_path, rel),
                    OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                )
                .await
                .map_err(sftp_err)?;
            loop {
                let n = rf.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                wf.write_all(&buf[..n]).await?;
                transferred += n as u64;
                if transferred - last >= SFTP_PROGRESS_STRIDE {
                    last = transferred;
                    last_emit = std::time::Instant::now();
                    emit_progress(app, window, dst_tab, transfer_id, transferred, total, false, None);
                }
            }
            wf.shutdown().await?;
            // Per-entry round trips dominate for trees of small files; keep
            // the indicator moving even when the byte stride hasn't tripped.
            if last_emit.elapsed() >= SFTP_PROGRESS_INTERVAL {
                last_emit = std::time::Instant::now();
                emit_progress(app, window, dst_tab, transfer_id, transferred, total, false, None);
            }
        }
        Ok::<u64, AppError>(transferred)
    }
    .await;
    finish_transfer(app, window, dst_tab, transfer_id, total, result)
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
