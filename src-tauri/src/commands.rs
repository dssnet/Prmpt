#[cfg(not(any(target_os = "ios", target_os = "android")))]
use tauri::menu::{IconMenuItemBuilder, MenuBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crossbeam_channel::unbounded;

use crate::{
    activate_blank_window, configure_new_window,
    config::{Config, Theme},
    error::{AppError, AppResult},
    protocol::{TabInfo, WindowBootstrap},
    schedule_refill,
    ssh::{self, SshConnectConfig},
    stronghold::{self, StrongholdUnlock},
    tab::{PtyEvent, ScrollKind, SharedRegistry},
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
        )
    }
}

#[tauri::command]
pub fn close_tab(registry: State<'_, SharedRegistry>, tab_id: u64) -> AppResult<()> {
    registry.close(tab_id)
}

#[tauri::command]
pub fn write_input(
    registry: State<'_, SharedRegistry>,
    tab_id: u64,
    bytes: Vec<u8>,
) -> AppResult<()> {
    registry.write_input(tab_id, bytes)
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

#[tauri::command]
pub fn list_tabs(registry: State<'_, SharedRegistry>) -> Vec<TabInfo> {
    registry.list()
}

#[tauri::command]
pub fn get_config(config: State<'_, SharedConfig>) -> Config {
    config.lock().clone()
}

#[tauri::command]
pub fn set_theme(config: State<'_, SharedConfig>, theme: Theme) -> AppResult<()> {
    let mut guard = config.lock();
    guard.theme = theme;
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

#[tauri::command]
pub fn tear_off_tab(
    app: AppHandle,
    registry: State<'_, SharedRegistry>,
    counter: State<'_, SharedWindowCounter>,
    pending: State<'_, SharedPendingHydration>,
    pool: State<'_, SharedWindowPool>,
    args: TearOffArgs,
) -> AppResult<String> {
    // Position so the drop point lands at the window's center rather
    // than its top-left, matching how a torn-off tab "becomes" the new
    // window under the cursor.
    let pos_x = args.screen_x - args.width / 2.0;
    let pos_y = args.screen_y - args.height / 2.0;

    // Fast path: an already-booted reserve we can resize, reposition,
    // adopt the torn-off tab into, and show. Falls back to building a
    // fresh window if no Ready reserve is available.
    if let Some(label) = pool.pop_for_tear_off() {
        if let Some(window) = app.get_webview_window(&label) {
            // Defensive: a reserve should have no tabs in the registry.
            // If something accidentally attached one earlier (e.g., an
            // older build's hit-test that didn't skip hidden reserves),
            // kill it before adopting the torn-off tab so the activated
            // window shows just the one tab the user expects. The
            // terminal:exit event removes any matching pill from the
            // reserve's frontend state.
            for existing_id in registry.tabs_in_window(&label) {
                let _ = registry.close(existing_id);
            }
            let _ = window.set_size(LogicalSize::new(args.width, args.height));
            let _ = window.set_position(LogicalPosition::new(pos_x, pos_y));
            registry.set_window(args.tab_id, label.clone())?;
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
            let _ = window.show();
            let _ = window.set_focus();
            // Defer the replacement build off the command thread.
            // Otherwise `WebviewWindowBuilder::build` runs back-to-back
            // with the show()/focus() we just issued, and on macOS the
            // new reserve's NSWindow init competes for the same main
            // runloop that's trying to actually paint the window we
            // just made visible.
            schedule_refill(&app);
            return Ok(label);
        }
        pool.note_destroyed(&label);
    }

    let label = format!("window-{}", counter.next());

    // Stash the hydration list BEFORE registering the tab's new owner so
    // that the frontend's first call to list_tabs_for_window (after the
    // webview boots) always sees this tab. Then build the window; only
    // when the window exists do we hand off ownership so the next render
    // emit can find a real webview target.
    pending
        .0
        .lock()
        .entry(label.clone())
        .or_default()
        .push(args.tab_id);

    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("Prmpt")
        .inner_size(args.width, args.height)
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

    registry.set_window(args.tab_id, label.clone())?;

    // Top the pool back up after spending a fallback build slot too —
    // building the fresh window already happened, but the pool itself
    // was empty when we entered. Deferred for the same main-thread
    // reasons as the fast path above.
    schedule_refill(&app);

    Ok(label)
}

/// Cmd+N entry point. Pops a Ready reserve or falls back to building a
/// fresh blank window — same shape as the macOS dock-click handler.
#[tauri::command]
pub fn open_new_window(app: AppHandle) -> AppResult<()> {
    activate_blank_window(&app);
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

/// Open a tab backed by an SSH session. The frontend assembles the
/// `SshConnectConfig` from the SQL plugin (host row + port forwards)
/// and the Stronghold plugin (decrypted secrets) before invoking this.
#[tauri::command]
pub fn connect_ssh_host(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, SharedRegistry>,
    runtime: State<'_, SharedRuntime>,
    config: State<'_, SharedConfig>,
    args: SshConnectArgs,
) -> AppResult<u64> {
    let scrollback = config.lock().scrollback_lines;
    let cols = args.cols.max(1);
    let rows = args.rows.max(1);
    let host_id = args.config.host_id;
    let host_label = args.config.label.clone();

    let id = registry.next_tab_id();
    let (pty_tx, pty_rx) = unbounded::<PtyEvent>();
    let out_tx = ssh::spawn_session(
        runtime.inner().as_ref(),
        app.clone(),
        window.label().to_string(),
        id,
        args.config,
        pty_tx,
        cols,
        rows,
    );

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
    )?;

    let _ = args.cell_width_px;
    let _ = args.cell_height_px;
    Ok(id)
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

#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[tauri::command]
#[allow(unused_mut)] // `mut` is needed on macOS where the icon path reassigns the builders
pub fn show_context_menu(app: AppHandle, window: WebviewWindow) -> AppResult<()> {
    let mut copy_builder = IconMenuItemBuilder::with_id("copy", "Copy");
    let mut paste_builder = IconMenuItemBuilder::with_id("paste", "Paste");
    #[cfg(target_os = "macos")]
    {
        if let Some(img) = crate::macos::sf_symbol_image("doc.on.doc") {
            copy_builder = copy_builder.icon(img);
        }
        if let Some(img) = crate::macos::sf_symbol_image("doc.on.clipboard") {
            paste_builder = paste_builder.icon(img);
        }
    }
    let copy = copy_builder
        .build(&app)
        .map_err(|e| AppError::Other(e.to_string()))?;
    let paste = paste_builder
        .build(&app)
        .map_err(|e| AppError::Other(e.to_string()))?;
    let menu = MenuBuilder::new(&app)
        .items(&[&copy, &paste])
        .build()
        .map_err(|e| AppError::Other(e.to_string()))?;
    window
        .popup_menu(&menu)
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(())
}

// Mobile has no popup menu; surface the same command name so the
// frontend can call it unconditionally and get a clean no-op.
#[cfg(any(target_os = "ios", target_os = "android"))]
#[tauri::command]
pub fn show_context_menu(_app: AppHandle, _window: WebviewWindow) -> AppResult<()> {
    Ok(())
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
        let _ = window.close();
    }
}
