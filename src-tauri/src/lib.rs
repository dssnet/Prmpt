mod backup;
mod commands;
mod config;
mod data_migrations;
mod error;
mod keymap;
mod localfs;
#[cfg(target_os = "macos")]
mod macos;
mod osc_notify;
mod paths;
mod platform;
mod protocol;
mod secret_store;
mod secure_store;
mod ssh;
mod stronghold;
mod tab;
mod window_pool;

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

use config::Config;
use parking_lot::Mutex;
use tab::TabRegistry;
#[cfg(target_os = "macos")]
use tauri::menu::{IconMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_sql::{Migration, MigrationKind};

pub type SharedConfig = Arc<Mutex<Config>>;
pub type SharedRuntime = Arc<tokio::runtime::Runtime>;

/// URL handed to `tauri-plugin-sql` and returned to the frontend by
/// `get_db_url`. Resolved at startup from `paths::db_url()` so both
/// sides agree on the (absolute, OS-specific) connection string.
pub struct DbUrl(pub String);

/// Monotonic counter used to label runtime-created windows
/// (`"window-1"`, `"window-2"`, ...). The initial window keeps the
/// `"main"` label declared in `tauri.conf.json`.
#[derive(Default)]
pub struct WindowCounter(pub AtomicU64);

impl WindowCounter {
    pub fn next(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }
}

/// Set when an explicit `app.exit(0)` (menu / Cmd+Q) has fired so the
/// per-window Destroyed handlers know not to respawn a reserve mid-shutdown.
/// The no-windows-left auto-exit is `prevent_exit`'d, so it never sets this.
pub static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// Tab IDs queued for hydration into a window that hasn't yet booted
/// its frontend. The frontend drains its entry via
/// `list_tabs_for_window` on init.
#[derive(Default)]
pub struct PendingHydration(pub Mutex<HashMap<String, Vec<u64>>>);

pub type SharedWindowCounter = Arc<WindowCounter>;
pub type SharedPendingHydration = Arc<PendingHydration>;
pub use window_pool::SharedWindowPool;

/// Conservative default terminal geometry for a tab the backend
/// pre-spawns before its window's webview has booted. The frontend
/// corrects this to the real size via `resize_tab` on hydrate (the same
/// reflow the tear-off path relies on), so these only need to be
/// plausible enough for the shell to start cleanly.
const PRESPAWN_COLS: u16 = 100;
const PRESPAWN_ROWS: u16 = 30;

/// The full migration set as `(version, description, sql)`, one source of
/// truth shared by [`ssh_migrations`] (what `tauri-plugin-sql` runs) and
/// `backup::reconcile_migration_checksums` (which re-stamps an imported
/// DB's recorded checksums against these exact SQL bodies). The SQL lives
/// in `src-tauri/migrations/` and is inlined at compile time.
pub const MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "init", include_str!("../migrations/0001_init.sql")),
    (2, "stronghold", include_str!("../migrations/0002_stronghold.sql")),
    (3, "broken_flag", include_str!("../migrations/0003_broken_flag.sql")),
    (4, "groups", include_str!("../migrations/0004_groups.sql")),
    (5, "group_flags", include_str!("../migrations/0005_group_flags.sql")),
    (6, "disable_sftp", include_str!("../migrations/0006_disable_sftp.sql")),
    (7, "disable_ssh", include_str!("../migrations/0007_disable_ssh.sql")),
];

/// Migrations consumed by `tauri-plugin-sql` at startup, built from
/// [`MIGRATIONS`].
fn ssh_migrations() -> Vec<Migration> {
    MIGRATIONS
        .iter()
        .map(|&(version, description, sql)| Migration {
            version,
            description,
            sql,
            kind: MigrationKind::Up,
        })
        .collect()
}

/// Attach to the parent console on Windows so a release build launched from
/// PowerShell / cmd actually surfaces panic messages and `eprintln!` output.
/// Release builds are `windows_subsystem = "windows"` (so we don't pop a
/// console on Start-Menu launches), which means stderr/stdout are detached by
/// default — without this, a panic during startup exits silently with nothing
/// for the user to paste back.
#[cfg(target_os = "windows")]
fn try_attach_parent_console() {
    extern "system" {
        fn AttachConsole(dw_process_id: u32) -> i32;
    }
    // ATTACH_PARENT_PROCESS = (DWORD)-1. Failure is benign (no parent
    // console available, e.g. Explorer / shortcut launch).
    unsafe {
        let _ = AttachConsole(u32::MAX);
    }
}

#[cfg(not(target_os = "windows"))]
fn try_attach_parent_console() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    try_attach_parent_console();
    // Force backtraces so any startup panic prints a stack, not just the
    // bare message — the difference between "explain it" and "guess it".
    std::env::set_var("RUST_BACKTRACE", "1");

    // Apply a staged backup import, if one is pending, before anything
    // reads the data dir or opens the DB. This is the destructive swap
    // half of the import flow (see `backup.rs`); doing it here — ahead of
    // the SQL plugin — sidesteps the file lock on the open `prmpt.db`.
    if let Err(e) = backup::apply_pending_import() {
        eprintln!("[backup] apply pending import failed: {e}");
    }

    // Move any pre-unification on-disk state into the new `Prmpt` data
    // dir before anything else reads or writes it. See
    // `data_migrations/` for the framework and `v001_unify_data_dir.rs`
    // for the move logic.
    data_migrations::run().expect("apply data migrations");

    let registry: tab::SharedRegistry = Arc::new(TabRegistry::new());
    let cfg: SharedConfig = Arc::new(Mutex::new(Config::load_or_default()));
    let window_counter: SharedWindowCounter = Arc::new(WindowCounter::default());
    let pending: SharedPendingHydration = Arc::new(PendingHydration::default());
    let window_pool: SharedWindowPool = Arc::new(window_pool::WindowPool::new());
    let db_url = paths::db_url().expect("resolve db url");

    let runtime: SharedRuntime = Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("prmpt-async")
            .build()
            .expect("build tokio runtime"),
    );

    // Pre-create boot password + quarantine stale snapshot if needed.
    // The frontend calls `get_stronghold_unlock` early on to learn the
    // quarantine flag; the Rust-side SecretStore reads the same files
    // (lazily, on first secret access) to load the snapshot.
    //
    // A non-fatal failure here means we couldn't unlock the boot key —
    // the most common cause is the user denying the platform keychain
    // prompt. The snapshot is left untouched on disk, the SecretStore
    // will surface the same error on first secret access (so SSH
    // features fail with a clear message), and the user can retry by
    // relaunching. Panicking here would be strictly worse UX.
    if let Err(e) = stronghold::prepare_unlock_cached() {
        eprintln!("[stronghold] startup unlock failed: {e}; continuing with secrets locked");
    }

    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations(&db_url, ssh_migrations())
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(registry)
        .manage(cfg)
        .manage(window_counter)
        .manage(pending)
        .manage(window_pool)
        .manage(runtime)
        .manage(DbUrl(db_url))
        .manage(secret_store::SecretStore::new())
        .manage(ssh::new_sftp_slots())
        .manage(ssh::new_host_key_prompts())
        .invoke_handler(tauri::generate_handler![
            commands::spawn_tab,
            commands::close_tab,
            commands::write_input,
            commands::write_key,
            commands::write_paste,
            commands::resize_tab,
            commands::scroll_tab,
            commands::wheel_scroll,
            commands::copy_selection_text,
            commands::list_tabs,
            commands::get_config,
            commands::set_theme,
            commands::set_ui_prefs,
            commands::set_terminal_prefs,
            commands::forget_tab,
            commands::frontend_log,
            commands::show_context_menu,
            commands::tear_off_tab,
            commands::attach_tab,
            commands::list_tabs_for_window,
            commands::bootstrap_window,
            commands::open_new_window,
            commands::window_at_screen_point,
            commands::get_stronghold_unlock,
            commands::get_db_url,
            commands::connect_ssh_host,
            commands::ssh_confirm_host_key,
            commands::inspect_ssh_key,
            commands::sftp_list_dir,
            commands::sftp_realpath,
            commands::sftp_stat,
            commands::sftp_mkdir,
            commands::sftp_rename,
            commands::sftp_remove,
            commands::sftp_download,
            commands::sftp_upload,
            commands::sftp_relay,
            commands::local_home_dir,
            commands::list_local_dir,
            commands::local_drives,
            commands::local_mkdir,
            commands::local_rename,
            commands::local_remove,
            commands::local_reveal,
            commands::local_open,
            commands::full_disk_access_granted,
            commands::open_full_disk_access_settings,
            commands::secret_get,
            commands::secret_set,
            commands::secret_remove,
            commands::prepare_for_update,
            backup::export_backup,
            backup::import_backup,
        ]);

    // The updater plugin is desktop-only (mobile distributes via the
    // stores; no in-place self-update). Gate it on the same cfg the
    // Cargo dependency uses so the build stays consistent.
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    // iOS / Android have no menu bar — `on_menu_event` doesn't exist on
    // those targets, so the entire menu-dispatch closure is desktop-only.
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let builder = builder.on_menu_event(|app, event| {
            // Menu events fire from a single OS-level menu bar shared across
            // windows, so target only the focused webview. Otherwise Copy
            // would fire in every window simultaneously.
            let focused = app
                .webview_windows()
                .into_iter()
                .find(|(_, w)| w.is_focused().unwrap_or(false));
            let emit = |name: &str| match focused.as_ref() {
                Some((label, _)) => {
                    let _ = app.emit_to(EventTarget::webview_window(label), name, ());
                }
                None => {
                    let _ = app.emit(name, ());
                }
            };
            match event.id().0.as_str() {
                "copy" => emit("menu:copy"),
                "paste" => emit("menu:paste"),
                "selectAll" => emit("menu:selectAll"),
                // Explicit quit via menu/⌘Q. We route this through our own
                // handler (rather than PredefinedMenuItem::quit) so the
                // resulting ExitRequested carries `code = Some(0)`, which
                // distinguishes it from the no-more-windows auto-exit.
                "quit" => {
                    app.exit(0);
                }
                #[cfg(debug_assertions)]
                "devtools" => {
                    if let Some((_, w)) = focused.as_ref() {
                        w.open_devtools();
                    }
                }
                _ => {}
            }
        });

    builder
        .setup(|app| {
            // tauri-plugin-sql unconditionally creates `app_config_dir()` in
            // its own setup hook (the bundle-id folder, e.g.
            // `~/.config/de.dss-net.prmpt`). We don't use it — our DB lives
            // in the unified Prmpt/ dir — so reap the empty husk now that
            // plugin setups have run.
            data_migrations::cleanup_unused_app_config_dir(app.handle());

            // macOS uses an app-wide menu bar at the top of the screen, which
            // is where Cmd+Q / Cmd+C / Cmd+V accelerators are anchored.
            // Windows/Linux would render the same menu *attached to every
            // window* ("Prmpt | Edit" strip), which we don't want — the
            // terminal keymap in App.vue handles those chords directly, and
            // right-click → context menu still covers copy/paste/select-all.
            #[cfg(target_os = "macos")]
            install_app_menu(app.handle())?;
            if let Some(window) = app.get_webview_window("main") {
                configure_new_window(&window);
                // Fork the shell now so its rc files run while the
                // webview/font/WebGL bootstrap is still in flight,
                // instead of after it. The frontend hydrates this tab
                // via list_tabs_for_window rather than spawning its own.
                prespawn_tab_for_window(app.handle(), "main");
            }
            // Prime the reserve pool. The webview boot is async; the
            // reserve won't be eligible for popping until its frontend
            // calls bootstrap_window. Activations before then fall back
            // to building a fresh window — same UX as today.
            let pool = app.state::<SharedWindowPool>();
            pool.ensure_filled(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| match event {
            // Closing the last window should NOT exit the app (matches the
            // standard macOS convention). Tauri fires ExitRequested with
            // `code: None` for that path; our menu "quit" handler calls
            // `app.exit(0)` which gives `code: Some(0)`. Distinguish on
            // that and only prevent the no-code exits.
            RunEvent::ExitRequested { code, api, .. } if code.is_none() => {
                api.prevent_exit();
            }
            // Explicit quit (`app.exit(0)` from the menu / Cmd+Q). Mark
            // shutdown so per-window Destroyed handlers don't try to
            // respawn a reserve as the process tears down.
            RunEvent::ExitRequested { .. } => {
                SHUTTING_DOWN.store(true, Ordering::SeqCst);
            }
            // Dock-icon click on macOS. If the user has visible windows,
            // the OS already focuses one; we only intervene when nothing
            // is open so the click pops a fresh terminal window.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                activate_blank_window(_app);
            }
            _ => {}
        });
}

/// Pop a Ready reserve and surface it as a blank new window, or fall back
/// to building a fresh window if the pool isn't ready. Used by the macOS
/// dock-click handler and the `open_new_window` command (Cmd+N).
pub(crate) fn activate_blank_window(app: &AppHandle) {
    let pool = app.state::<SharedWindowPool>();
    if let Some(label) = pool.pop_for_blank() {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = app.emit_to(EventTarget::webview_window(&label), "window:activate-blank", ());
            let _ = window.show();
            let _ = window.set_focus();
            schedule_refill(app);
            return;
        }
        // Pool said Ready but the window vanished (shouldn't normally
        // happen). Clean up and fall through to the fresh-build path.
        pool.note_destroyed(&label);
    }
    if let Err(e) = open_blank_window(app) {
        eprintln!("activate_blank_window: fallback build failed: {e}");
    }
    schedule_refill(app);
}

/// Refill the reserve pool on the async runtime, off whatever thread the
/// caller is on. Building a window inline competes with the main runloop
/// that's still painting the window we just made visible.
pub(crate) fn schedule_refill<R: Runtime>(app: &AppHandle<R>) {
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let pool = app_clone.state::<SharedWindowPool>();
        pool.ensure_filled(&app_clone);
    });
}

fn open_blank_window(app: &AppHandle) -> tauri::Result<()> {
    let counter = app.state::<SharedWindowCounter>();
    let label = format!("window-{}", counter.next());
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title("Prmpt")
        .inner_size(960.0, 600.0)
        // Let HTML5 drag-and-drop work inside the webview (tab → terminal
        // workspace drops). Tauri's OS-level drag-drop handler otherwise
        // swallows dragover/drop events; tab tear-off only needs dragend.
        .disable_drag_drop_handler();
    // `title_bar_style` / `hidden_title` are macOS-only on
    // `WebviewWindowBuilder`; `focused(bool)` is desktop-only.
    #[cfg(target_os = "macos")]
    let builder = builder
        // Paint the native window the terminal background up front so the
        // brief webview cold-start shows a dark terminal-colored frame
        // instead of a white flash, rather than delaying the whole window.
        .background_color(tauri::window::Color(0x1e, 0x1e, 0x2e, 0xff))
        .title_bar_style(platform::title_bar_style())
        .hidden_title(platform::hidden_title());
    // Windows has no overlay-titlebar mode, so drop the native chrome
    // entirely — `TitleBar.vue` provides the draggable region. Linux
    // keeps native decorations: we let the desktop environment (Adwaita,
    // KWin, …) draw the chrome, which already gives us rounded corners
    // and shadows.
    #[cfg(target_os = "windows")]
    let builder = builder.decorations(false);
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let builder = builder.focused(true);
    let win = builder.visible(true).build()?;
    configure_new_window(&win);
    prespawn_tab_for_window(app, &label);
    Ok(())
}

/// Fork the user's shell for `label` *before* its webview finishes
/// booting, so rc-file execution (oh-my-zsh / Powerlevel10k, …) overlaps
/// the frontend's font/WebGL bring-up instead of being serialized after
/// it. The tab is stashed in `PendingHydration` so the frontend hydrates
/// it via `list_tabs_for_window` instead of issuing its own `spawn_tab`.
/// On any failure we log and bail; the frontend's fallback `spawnNewTab`
/// still produces a working terminal.
fn prespawn_tab_for_window(app: &AppHandle, label: &str) {
    let registry = app.state::<tab::SharedRegistry>();
    let config = app.state::<SharedConfig>();
    let (shell, scrollback_lines, cell_px) = {
        let guard = config.lock();
        (
            guard.shell.clone(),
            guard.scrollback_lines,
            guard.font_size.max(1.0) as u32,
        )
    };
    match registry.spawn(
        app.clone(),
        label.to_string(),
        PRESPAWN_COLS,
        PRESPAWN_ROWS,
        cell_px,
        cell_px,
        shell,
        scrollback_lines,
        config.inner().clone(),
    ) {
        Ok(id) => {
            let pending = app.state::<SharedPendingHydration>();
            pending
                .0
                .lock()
                .entry(label.to_string())
                .or_default()
                .push(id);
        }
        Err(e) => eprintln!("prespawn: failed to spawn tab for {label}: {e}"),
    }
}

#[cfg(target_os = "macos")]
#[allow(unused_mut)] // `mut` is needed on macOS where the icon path reassigns the builders
fn install_app_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    // macOS's default menu bar wires Edit > Copy/Paste to the system
    // `copy:`/`paste:` selectors on the first responder. Our terminal
    // canvas isn't an NSTextView, so those do nothing. Install custom
    // Copy/Paste items with the same IDs as the context menu so
    // `on_menu_event` routes both keyboard shortcuts and menu clicks
    // through the same handler.
    let pkg_name = app.package_info().name.clone();

    let quit = MenuItemBuilder::with_id("quit", "Quit")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, &pkg_name)
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&quit)
        .build()?;

    // Windows: the OS-level window-menu accelerator table claims plain
    // `Ctrl+C`/`Ctrl+V` before WebView2 sees them, so the terminal can
    // never get SIGINT or paste from the bare chord. Bind the menu to
    // `Ctrl+Shift+C/V` instead and let the keymap in App.vue handle the
    // plain chords directly (Windows Terminal convention).
    #[cfg(target_os = "macos")]
    let (copy_accel, paste_accel) = ("CmdOrCtrl+C", "CmdOrCtrl+V");
    #[cfg(target_os = "windows")]
    let (copy_accel, paste_accel) = ("Ctrl+Shift+C", "Ctrl+Shift+V");
    #[cfg(target_os = "linux")]
    let (copy_accel, paste_accel) = ("CmdOrCtrl+C", "CmdOrCtrl+V");

    let mut copy_builder = IconMenuItemBuilder::with_id("copy", "Copy").accelerator(copy_accel);
    let mut paste_builder = IconMenuItemBuilder::with_id("paste", "Paste").accelerator(paste_accel);
    #[cfg(target_os = "macos")]
    {
        if let Some(img) = macos::sf_symbol_image("doc.on.doc") {
            copy_builder = copy_builder.icon(img);
        }
        if let Some(img) = macos::sf_symbol_image("doc.on.clipboard") {
            paste_builder = paste_builder.icon(img);
        }
    }
    let copy = copy_builder.build(app)?;
    let paste = paste_builder.build(app)?;
    // Select All has no menu item by default — without one, Cmd+A is
    // owned by the JS shortcut table and never reaches focused inputs.
    // Routing it through the menu lets the frontend dispatch to either
    // the terminal or the focused form field, same as copy/paste.
    let select_all = MenuItemBuilder::with_id("selectAll", "Select All")
        .accelerator("CmdOrCtrl+A")
        .build(app)?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .items(&[&copy, &paste, &PredefinedMenuItem::separator(app)?, &select_all])
        .build()?;

    #[cfg(debug_assertions)]
    {
        let devtools = MenuItemBuilder::with_id("devtools", "Open DevTools")
            .accelerator("CmdOrCtrl+Alt+I")
            .build(app)?;
        let view_menu = SubmenuBuilder::new(app, "View").item(&devtools).build()?;
        let menu = MenuBuilder::new(app)
            .items(&[&app_menu, &edit_menu, &view_menu])
            .build()?;
        menu.set_as_app_menu()?;
        return Ok(());
    }

    #[cfg(not(debug_assertions))]
    {
        let menu = MenuBuilder::new(app)
            .items(&[&app_menu, &edit_menu])
            .build()?;
        menu.set_as_app_menu()?;
        Ok(())
    }
}

/// Per-window setup that must run for every webview window we create —
/// both the initial "main" window and any tear-off windows. Disables
/// macOS Writing Tools (which otherwise hijack right-clicks) and
/// installs a Destroyed handler so the window's tabs are reaped when
/// it closes.
pub fn configure_new_window<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "macos")]
    {
        let _ = window.with_webview(|webview| {
            macos::disable_writing_tools(webview.inner());
            // tauri-runtime-wry 2.11.1 builds the `PlatformWebview` passed
            // here by calling `Retained::into_raw` on the WKWebView, its
            // WKUserContentController, and the NSWindow — and never
            // reclaims those retains. Each call therefore leaks +1 retain
            // on each of those three objects; the NSWindow leak alone keeps
            // the whole chain (NSWindow → contentView → WKWebView → its
            // WebContent process) alive forever, so opening + closing a
            // window in a loop bloats Activity Monitor with stale
            // `localhost:1420` processes. Reclaim ownership via
            // `Retained::from_raw` and let it drop to restore the proper
            // refcount.
            unsafe {
                use objc2::rc::Retained;
                use objc2::runtime::NSObject;
                let _ = Retained::<NSObject>::from_raw(webview.inner() as *mut NSObject);
                let _ = Retained::<NSObject>::from_raw(webview.controller() as *mut NSObject);
                let _ = Retained::<NSObject>::from_raw(webview.ns_window() as *mut NSObject);
            }
        });
    }

    #[cfg(target_os = "windows")]
    {
        let _ = window.with_webview(|webview| {
            platform::disable_webview2_autofill(&webview);
        });
    }

    let label = window.label().to_string();
    let app = window.app_handle().clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let registry = app.state::<tab::SharedRegistry>();
            for tab_id in registry.tabs_in_window(&label) {
                let _ = registry.close(tab_id);
            }
            let pending = app.state::<SharedPendingHydration>();
            pending.0.lock().remove(&label);

            // Keep the reserve pool in sync. Skip during shutdown so we
            // don't try to build a replacement window while the app is
            // tearing down.
            let pool = app.state::<SharedWindowPool>();
            pool.note_destroyed(&label);
            if !SHUTTING_DOWN.load(Ordering::SeqCst) {
                schedule_refill(&app);
            }
        }
    });
}
