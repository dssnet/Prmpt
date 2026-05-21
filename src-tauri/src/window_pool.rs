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
//! Race-prevention design:
//! - The `Building → Ready` lifecycle is flipped by the reserve's frontend
//!   calling `bootstrap_window`. Until then `pop_*` returns `None` and the
//!   caller falls back to building a fresh window — same behavior as today.
//! - Activation never relies on a fire-and-forget Tauri event reaching a
//!   not-yet-mounted listener; the bootstrap call is what gates Ready.

use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc},
};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

use crate::{configure_new_window, SharedWindowCounter, SHUTTING_DOWN};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReserveState {
    Building,
    Ready,
}

#[derive(Default)]
pub struct WindowPool {
    // The single reserve label, or None.
    reserve: Mutex<Option<String>>,
    // Per-label state, populated only while a label is in `reserve`.
    states: Mutex<HashMap<String, ReserveState>>,
    // Per-label mode. Used by bootstrap_window to tell the frontend what to
    // do. Defaults to Normal for unknown labels.
    modes: Mutex<HashMap<String, WindowMode>>,
}

pub type SharedWindowPool = Arc<WindowPool>;

impl WindowPool {
    pub fn new() -> Self {
        Self::default()
    }

    /// What the frontend should do on bootstrap. Returns `Reserve` only for
    /// labels currently held in the pool; everything else (main, torn-off
    /// fresh windows, already-activated reserves) is `Normal`.
    pub fn mode_for(&self, label: &str) -> WindowMode {
        self.modes
            .lock()
            .get(label)
            .copied()
            .unwrap_or(WindowMode::Normal)
    }

    /// Flip a reserve from `Building` to `Ready`. Called when its frontend
    /// invokes `bootstrap_window` (which is also the moment we know all the
    /// reserve's event listeners are installed and it can receive activation
    /// events / tab attachments without losing them).
    pub fn mark_ready(&self, label: &str) {
        if let Some(s) = self.states.lock().get_mut(label) {
            *s = ReserveState::Ready;
        }
    }

    /// Take a reserve for a blank-window activation (dock-click or Cmd+N).
    /// Returns the label only if a `Ready` reserve exists; otherwise None
    /// and the caller falls back to building fresh.
    pub fn pop_for_blank(&self) -> Option<String> {
        self.pop_ready()
    }

    /// Take a reserve for a tab tear-off activation.
    pub fn pop_for_tear_off(&self) -> Option<String> {
        self.pop_ready()
    }

    fn pop_ready(&self) -> Option<String> {
        let mut reserve = self.reserve.lock();
        let label = reserve.as_ref()?.clone();
        let mut states = self.states.lock();
        if states.get(&label) != Some(&ReserveState::Ready) {
            return None;
        }
        states.remove(&label);
        self.modes.lock().remove(&label);
        *reserve = None;
        Some(label)
    }

    /// Clear pool entries for a destroyed window. Does NOT spawn a
    /// replacement — `ensure_filled` is the caller's responsibility. (Kept
    /// separate so the Destroyed handler can skip respawn during shutdown.)
    pub fn note_destroyed(&self, label: &str) {
        let mut reserve = self.reserve.lock();
        if reserve.as_deref() == Some(label) {
            *reserve = None;
        }
        self.states.lock().remove(label);
        self.modes.lock().remove(label);
    }

    /// Idempotent: spawn one reserve if the pool is empty and we're not
    /// shutting down. Tolerant of build failures — logs and bails so the
    /// next trigger can retry.
    pub fn ensure_filled<R: Runtime>(&self, app: &AppHandle<R>) {
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            return;
        }
        if self.reserve.lock().is_some() {
            return;
        }
        if let Err(e) = self.spawn_reserve(app) {
            eprintln!("window_pool: failed to spawn reserve: {e}");
        }
    }

    fn spawn_reserve<R: Runtime>(&self, app: &AppHandle<R>) -> tauri::Result<()> {
        let counter = app.state::<SharedWindowCounter>();
        let label = format!("window-{}", counter.next());

        // Mirror open_blank_window's builder chain exactly, minus
        // `.focused(true)` (focus is applied on activation) and with
        // `.visible(false)` so the reserve never flashes onto the user's
        // screen at construction time.
        let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::default())
            .title("Prmpt")
            .inner_size(960.0, 600.0)
            .background_color(tauri::window::Color(0x1e, 0x1e, 0x2e, 0xff))
            .disable_drag_drop_handler();
        #[cfg(target_os = "macos")]
        let builder = builder
            .title_bar_style(platform::title_bar_style())
            .hidden_title(platform::hidden_title());
        let window = builder.visible(false).build()?;
        configure_new_window(&window);

        // Insert pool entries AFTER build so a Destroyed event firing
        // during construction can't race ahead of us. The webview hasn't
        // booted yet, so a bootstrap_window call from it is impossible
        // before we return.
        self.modes
            .lock()
            .insert(label.clone(), WindowMode::Reserve);
        self.states
            .lock()
            .insert(label.clone(), ReserveState::Building);
        *self.reserve.lock() = Some(label);
        Ok(())
    }
}
