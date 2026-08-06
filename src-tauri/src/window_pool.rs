//! Pre-warmed reserve window pool.
//!
//! Maintains exactly one hidden, fully-bootstrapped reserve window so that
//! "open a new window" actions (macOS dock-click, tab tear-off, Cmd+N) can
//! unhide an already-running webview instead of paying the cost of building
//! one synchronously. After an activation, a replacement reserve is spawned
//! asynchronously to restore the invariant.
//!
//! Reserves are *empty* (no prespawned tab). The shell is forked only on
//! activation. This mirrors the existing tear-off contract (one tab per
//! torn-off window) without wasting a shell process per reserve.
//!
//! **This module owns no state.** The reserve slot used to be a second mutex
//! here (`Empty → Building → Ready → Empty`) that could disagree with the
//! registry's view of the same windows — a `Ready` label naming a window that
//! had since been destroyed, and every popper carrying its own "did it
//! actually still exist?" fallback. The slot is now just a window's `kind` in
//! `ownership.rs`, so "is a reserve already claimed?" and "claim it" happen in
//! one lock acquisition, and a destroyed reserve frees the slot by virtue of
//! being `Gone`. What is left here is the builder chain.

use std::sync::{atomic::Ordering, Arc};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

use crate::ownership::WindowKind;
use crate::{configure_new_window, tab::SharedRegistry, SharedWindowCounter, SHUTTING_DOWN};

#[cfg(target_os = "macos")]
use crate::platform;

/// Bootstrap-time signal to the frontend describing how this window should
/// behave: a `Reserve` window stays idle waiting for an activation; a
/// `Normal` window proceeds with tab hydration / spawn.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WindowMode {
    Reserve,
    Normal,
}

#[derive(Default)]
pub struct WindowPool;

pub type SharedWindowPool = Arc<WindowPool>;

impl WindowPool {
    pub fn new() -> Self {
        Self
    }

    /// Idempotent: build one reserve if none is claimed and we aren't shutting
    /// down. `claim_reserve` both tests and claims under the registry lock, so
    /// two concurrent callers can't each build a hidden window and orphan one
    /// of them. Tolerant of build failures — logs, releases the claim, and
    /// bails so the next trigger can retry.
    pub fn ensure_filled<R: Runtime>(&self, app: &AppHandle<R>) {
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            return;
        }
        let registry = app.state::<SharedRegistry>();
        let label = format!("window-{}", app.state::<SharedWindowCounter>().next());
        if !registry.claim_reserve(&label) {
            return;
        }
        if let Err(e) = self.spawn_reserve(app, &label) {
            eprintln!("window_pool: failed to spawn reserve: {e}");
            // Release the claim so the next trigger can retry. `mark_window_gone`
            // is the same thing the Destroyed handler would have done.
            registry.mark_window_gone(&label);
        }
    }

    fn spawn_reserve<R: Runtime>(&self, app: &AppHandle<R>, label: &str) -> tauri::Result<()> {
        // Mirror open_blank_window's builder chain exactly, minus
        // `.focused(true)` (focus is applied on activation) and with
        // `.visible(false)` so the reserve never flashes onto the user's
        // screen at construction time.
        let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
            .title("Prmpt")
            .inner_size(960.0, 600.0)
            .disable_drag_drop_handler();
        #[cfg(target_os = "macos")]
        let builder = builder
            .background_color(tauri::window::Color(0x1e, 0x1e, 0x2e, 0xff))
            .title_bar_style(platform::title_bar_style())
            .hidden_title(platform::hidden_title());
        // Match open_blank_window on Windows: no native chrome (TitleBar.vue
        // provides the draggable region). Linux keeps native decorations
        // (see open_blank_window for why).
        #[cfg(target_os = "windows")]
        let builder = builder.decorations(false);
        let window = builder.visible(false).build()?;
        // Re-registers the label the claim above already staked out; same
        // kind, so this is idempotent.
        configure_new_window(&window, WindowKind::ReserveBuilding);

        // If shutdown fired during the (slow) build, tear the just-built
        // window down. The Destroyed handler installed by
        // `configure_new_window` frees the reserve slot.
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            crate::warn_on_err("close", label, window.close());
        }
        Ok(())
    }
}
