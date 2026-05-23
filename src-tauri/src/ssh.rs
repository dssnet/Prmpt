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
use serde::Deserialize;
use tauri::{AppHandle, Emitter, EventTarget};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use zeroize::ZeroizeOnDrop;

use crate::{
    error::{AppError, AppResult},
    protocol::{SshConnectError, SshHostKeyFirstConnect, SshHostKeyMismatch, SshPortForwardError},
    tab::{PtyEvent, SshIoCmd},
};

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
/// outbound command channel.
pub fn spawn_session(
    rt: &tokio::runtime::Runtime,
    app: AppHandle,
    owner_window: String,
    tab_id: u64,
    config: SshConnectConfig,
    pty_tx: crossbeam_channel::Sender<PtyEvent>,
    cols: u16,
    rows: u16,
) -> mpsc::Sender<SshIoCmd> {
    let (out_tx, out_rx) = mpsc::channel::<SshIoCmd>(128);
    rt.spawn(session_task(
        app,
        owner_window,
        tab_id,
        config,
        pty_tx,
        out_rx,
        cols,
        rows,
    ));
    out_tx
}

async fn session_task(
    app: AppHandle,
    owner_window: String,
    tab_id: u64,
    config: SshConnectConfig,
    pty_tx: crossbeam_channel::Sender<PtyEvent>,
    out_rx: mpsc::Receiver<SshIoCmd>,
    cols: u16,
    rows: u16,
) {
    // Preserve host identity for the error event; `config` is moved into
    // `run_session`.
    let host_id = config.host_id;
    let host_label = config.label.clone();
    let hostname = config.hostname.clone();
    if let Err(e) = run_session(
        app.clone(),
        owner_window.clone(),
        tab_id,
        config,
        &pty_tx,
        out_rx,
        cols,
        rows,
    )
    .await
    {
        let raw = e.to_string();
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
    }
    let _ = pty_tx.send(PtyEvent::Eof);
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
    app: AppHandle,
    owner_window: String,
    tab_id: u64,
    config: SshConnectConfig,
    pty_tx: &crossbeam_channel::Sender<PtyEvent>,
    mut out_rx: mpsc::Receiver<SshIoCmd>,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
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
        stored_fp: config.stored_fingerprint.clone(),
        app: app.clone(),
        owner_window: owner_window.clone(),
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
            return Ok(());
        }
        return Err(AppError::Ssh(
            "authentication failed (check password / key / agent identities)".into(),
        ));
    }

    // TOFU: emit the captured fingerprint so the frontend can persist it.
    if let Some((fp, alg)) = state.lock().captured_fp.take() {
        let _ = app.emit_to(
            EventTarget::webview_window(&owner_window),
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
        .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
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
    for fw in config.forwards {
        let handle = session.clone();
        let app_for_task = app.clone();
        let window_for_task = owner_window.clone();
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

    drive_channel_loop(&mut channel, pty_tx, &mut out_rx).await;

    for t in forward_tasks {
        t.abort();
    }

    let s = session.lock().await;
    let _ = s.disconnect(Disconnect::ByApplication, "", "").await;
    Ok(())
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
) {
    loop {
        tokio::select! {
            biased;
            cmd = out_rx.recv() => {
                match cmd {
                    Some(SshIoCmd::Write(bytes)) => {
                        if let Err(e) = channel.data(&bytes[..]).await {
                            eprintln!("[ssh] write to channel failed: {e:?}");
                            break;
                        }
                    }
                    Some(SshIoCmd::Resize { cols, rows, w_px, h_px }) => {
                        let _ = channel
                            .window_change(cols as u32, rows as u32, w_px, h_px)
                            .await;
                    }
                    Some(SshIoCmd::Close) | None => {
                        let _ = channel.eof().await;
                        break;
                    }
                }
            }
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        if pty_tx.send(PtyEvent::Data(data.to_vec())).is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if pty_tx.send(PtyEvent::Data(data.to_vec())).is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::Eof) => {
                        // Server signalled EOF; wait for ExitStatus too.
                    }
                    Some(ChannelMsg::ExitStatus { .. })
                    | Some(ChannelMsg::ExitSignal { .. }) => {
                        break;
                    }
                    None => break,
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
