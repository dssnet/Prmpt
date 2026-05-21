#[cfg(not(any(target_os = "ios", target_os = "android")))]
use tauri::menu::{IconMenuItemBuilder, MenuBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crossbeam_channel::unbounded;

use crate::{
    configure_new_window,
    config::{Config, Theme},
    error::{AppError, AppResult},
    protocol::TabInfo,
    ssh::{self, SshConnectConfig},
    stronghold::{self, StrongholdUnlock},
    tab::{PtyEvent, ScrollKind, SharedRegistry},
    DbUrl, SharedConfig, SharedPendingHydration, SharedRuntime, SharedWindowCounter,
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
    args: TearOffArgs,
) -> AppResult<String> {
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

    // Position so the drop point lands at the window's center rather
    // than its top-left, matching how a torn-off tab "becomes" the new
    // window under the cursor.
    let pos_x = args.screen_x - args.width / 2.0;
    let pos_y = args.screen_y - args.height / 2.0;
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
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let builder = builder.focused(true);
    let window = builder
        .visible(true)
        .build()
        .map_err(|e| AppError::Other(format!("build window: {e}")))?;

    configure_new_window(&window);

    registry.set_window(args.tab_id, label.clone())?;
    Ok(label)
}

#[tauri::command]
pub fn attach_tab(
    app: AppHandle,
    registry: State<'_, SharedRegistry>,
    tab_id: u64,
    target_label: String,
) -> AppResult<()> {
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
    stronghold::prepare_unlock()
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
