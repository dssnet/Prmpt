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
//! - The slot is flipped to `Building(label)` *before* the slow
//!   `WebviewWindowBuilder::build()` runs, while the lock is still held. A
//!   second concurrent `ensure_filled` therefore sees a non-`Empty` slot and
//!   bails out — without this, both callers would race past the check,
//!   build two hidden windows, and the second's slot write would orphan the
//!   first (a hidden WKWebView nobody can pop or destroy).
//! - `Building → Ready` is flipped by the reserve's frontend calling
//!   `bootstrap_window`. Until then `pop_*` returns `None` and the caller
//!   falls back to building a fresh window — same behavior as today.

use std::sync::{atomic::Ordering, Arc};

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

/// Reserve-pool slot lifecycle. Transitions:
///   `Empty` → `Building(label)` → `Ready(label)` → `Empty`
///
/// The slot is moved into `Building` while the lock is still held in
/// `ensure_filled`, so a second concurrent caller observes a non-`Empty`
/// slot and skips its own build. `Ready` is the only state `pop_*` will
/// take from; `note_destroyed` resets the slot if the destroyed label
/// matches the slot's current label.
#[derive(Default)]
enum ReserveSlot {
    #[default]
    Empty,
    Building(String),
    Ready(String),
}

impl ReserveSlot {
    fn label(&self) -> Option<&str> {
        match self {
            ReserveSlot::Empty => None,
            ReserveSlot::Building(l) | ReserveSlot::Ready(l) => Some(l.as_str()),
        }
    }
}

#[derive(Default)]
pub struct WindowPool {
    slot: Mutex<ReserveSlot>,
}

pub type SharedWindowPool = Arc<WindowPool>;

impl WindowPool {
    pub fn new() -> Self {
        Self::default()
    }

    /// What the frontend should do on bootstrap. Returns `Reserve` only for
    /// the label currently held in the pool (either still Building or
    /// already Ready); everything else (main, torn-off fresh windows,
    /// already-activated reserves) is `Normal`.
    pub fn mode_for(&self, label: &str) -> WindowMode {
        if self.slot.lock().label() == Some(label) {
            WindowMode::Reserve
        } else {
            WindowMode::Normal
        }
    }

    /// Flip the reserve from `Building` to `Ready`. Called when its frontend
    /// invokes `bootstrap_window` (which is also the moment we know all the
    /// reserve's event listeners are installed and it can receive activation
    /// events / tab attachments without losing them). No-op if the slot's
    /// label doesn't match (e.g., already popped, or this is a different
    /// reserve from a later refill cycle).
    pub fn mark_ready(&self, label: &str) {
        let mut slot = self.slot.lock();
        if let ReserveSlot::Building(l) = &*slot {
            if l == label {
                *slot = ReserveSlot::Ready(label.to_string());
            }
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
        let mut slot = self.slot.lock();
        if !matches!(*slot, ReserveSlot::Ready(_)) {
            return None;
        }
        match std::mem::take(&mut *slot) {
            ReserveSlot::Ready(label) => Some(label),
            _ => unreachable!(),
        }
    }

    /// Clear the slot if the destroyed window was the one we were tracking.
    /// Does NOT spawn a replacement — `ensure_filled` is the caller's
    /// responsibility. (Kept separate so the Destroyed handler can skip
    /// respawn during shutdown.)
    pub fn note_destroyed(&self, label: &str) {
        let mut slot = self.slot.lock();
        if slot.label() == Some(label) {
            *slot = ReserveSlot::Empty;
        }
    }

    /// Idempotent: spawn one reserve if the pool is empty and we're not
    /// shutting down. The slot is claimed (set to `Building(label)`) while
    /// the lock is still held, so two concurrent callers cannot both kick
    /// off `spawn_reserve` and orphan one of the resulting hidden windows.
    /// Tolerant of build failures — logs, rolls the slot back to `Empty`,
    /// and bails so the next trigger can retry.
    pub fn ensure_filled<R: Runtime>(&self, app: &AppHandle<R>) {
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            return;
        }
        let label = {
            let mut slot = self.slot.lock();
            if !matches!(*slot, ReserveSlot::Empty) {
                return;
            }
            let counter = app.state::<SharedWindowCounter>();
            let label = format!("window-{}", counter.next());
            *slot = ReserveSlot::Building(label.clone());
            label
        };
        if let Err(e) = self.spawn_reserve(app, &label) {
            eprintln!("window_pool: failed to spawn reserve: {e}");
            let mut slot = self.slot.lock();
            if matches!(&*slot, ReserveSlot::Building(l) if l == &label) {
                *slot = ReserveSlot::Empty;
            }
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
        configure_new_window(&window);

        // If shutdown fired during the (slow) build, tear the just-built
        // window down. The Destroyed handler installed by
        // `configure_new_window` calls `note_destroyed`, which resets the
        // slot back to Empty.
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            let _ = window.close();
        }
        Ok(())
    }
}
