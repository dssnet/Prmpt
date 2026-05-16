mod commands;
mod config;
mod error;
#[cfg(target_os = "macos")]
mod macos;
mod platform;
mod protocol;
mod secure_store;
mod ssh;
mod stronghold;
mod tab;

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use config::Config;
use parking_lot::Mutex;
use tab::TabRegistry;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use tauri::menu::{IconMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_sql::{Migration, MigrationKind};

pub type SharedConfig = Arc<Mutex<Config>>;
pub type SharedRuntime = Arc<tokio::runtime::Runtime>;

/// URL the SQL plugin registers the database under. Mirrors the value
/// in `tauri.conf.json`'s `plugins.sql.preload`.
const DB_URL: &str = "sqlite:prmpt.db";

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

/// Tab IDs queued for hydration into a window that hasn't yet booted
/// its frontend. The frontend drains its entry via
/// `list_tabs_for_window` on init.
#[derive(Default)]
pub struct PendingHydration(pub Mutex<HashMap<String, Vec<u64>>>);

pub type SharedWindowCounter = Arc<WindowCounter>;
pub type SharedPendingHydration = Arc<PendingHydration>;

/// Conservative default terminal geometry for a tab the backend
/// pre-spawns before its window's webview has booted. The frontend
/// corrects this to the real size via `resize_tab` on hydrate (the same
/// reflow the tear-off path relies on), so these only need to be
/// plausible enough for the shell to start cleanly.
const PRESPAWN_COLS: u16 = 100;
const PRESPAWN_ROWS: u16 = 30;

/// Migrations consumed by `tauri-plugin-sql` at startup. The SQL bodies
/// live in `src-tauri/migrations/` and are inlined at compile time.
fn ssh_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "init",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "stronghold",
            sql: include_str!("../migrations/0002_stronghold.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "broken_flag",
            sql: include_str!("../migrations/0003_broken_flag.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let registry: tab::SharedRegistry = Arc::new(TabRegistry::new());
    let cfg: SharedConfig = Arc::new(Mutex::new(Config::load_or_default()));
    let window_counter: SharedWindowCounter = Arc::new(WindowCounter::default());
    let pending: SharedPendingHydration = Arc::new(PendingHydration::default());

    let runtime: SharedRuntime = Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("prmpt-async")
            .build()
            .expect("build tokio runtime"),
    );

    // Pre-create boot password + quarantine stale snapshot if needed.
    // The frontend calls `get_stronghold_unlock` early on, which reads
    // the same files — doing it here ensures the JS plugin's
    // `Stronghold.load` won't burn scrypt time on an undecryptable file.
    stronghold::prepare_unlock().expect("prepare stronghold snapshot");

    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations(DB_URL, ssh_migrations())
                .build(),
        )
        .plugin(
            tauri_plugin_stronghold::Builder::new(|password| {
                // The frontend hands us the boot password as a 64-char
                // hex string. The plugin's `KeyProvider` wants raw 32
                // bytes — decode here. An invalid encoding falls through
                // to a zero key and the snapshot fails to open, which
                // is the right behavior (don't silently re-encrypt with
                // a bogus key).
                hex::decode(password.trim()).unwrap_or_default()
            })
            .build(),
        )
        .manage(registry)
        .manage(cfg)
        .manage(window_counter)
        .manage(pending)
        .manage(runtime)
        .invoke_handler(tauri::generate_handler![
            commands::spawn_tab,
            commands::close_tab,
            commands::write_input,
            commands::resize_tab,
            commands::scroll_tab,
            commands::list_tabs,
            commands::get_config,
            commands::set_theme,
            commands::forget_tab,
            commands::show_context_menu,
            commands::tear_off_tab,
            commands::attach_tab,
            commands::list_tabs_for_window,
            commands::window_at_screen_point,
            commands::get_stronghold_unlock,
            commands::connect_ssh_host,
            commands::full_disk_access_granted,
            commands::open_full_disk_access_settings,
        ]);

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
            #[cfg(not(any(target_os = "ios", target_os = "android")))]
            install_app_menu(app.handle())?;
            if let Some(window) = app.get_webview_window("main") {
                configure_new_window(&window);
                // Fork the shell now so its rc files run while the
                // webview/font/WebGL bootstrap is still in flight,
                // instead of after it. The frontend hydrates this tab
                // via list_tabs_for_window rather than spawning its own.
                prespawn_tab_for_window(app.handle(), "main");
            }
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
            // Dock-icon click on macOS. If the user has visible windows,
            // the OS already focuses one; we only intervene when nothing
            // is open so the click pops a fresh terminal window.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                if let Err(e) = open_blank_window(_app) {
                    eprintln!("reopen: failed to open new window: {e}");
                }
            }
            _ => {}
        });
}

fn open_blank_window(app: &AppHandle) -> tauri::Result<()> {
    let counter = app.state::<SharedWindowCounter>();
    let label = format!("window-{}", counter.next());
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
        .title("Prmpt")
        .inner_size(960.0, 600.0)
        // Paint the native window the terminal background up front so the
        // brief webview cold-start shows a dark terminal-colored frame
        // instead of a white flash, rather than delaying the whole window.
        .background_color(tauri::window::Color(0x1e, 0x1e, 0x2e, 0xff))
        // Let HTML5 drag-and-drop work inside the webview (tab → terminal
        // workspace drops). Tauri's OS-level drag-drop handler otherwise
        // swallows dragover/drop events; tab tear-off only needs dragend.
        .disable_drag_drop_handler();
    // `title_bar_style` / `hidden_title` are macOS-only on
    // `WebviewWindowBuilder`; `focused(bool)` is desktop-only.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(platform::title_bar_style())
        .hidden_title(platform::hidden_title());
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

#[cfg(not(any(target_os = "ios", target_os = "android")))]
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

    let mut copy_builder = IconMenuItemBuilder::with_id("copy", "Copy").accelerator("CmdOrCtrl+C");
    let mut paste_builder = IconMenuItemBuilder::with_id("paste", "Paste").accelerator("CmdOrCtrl+V");
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
        }
    });
}
