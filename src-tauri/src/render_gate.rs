//! When a tab is allowed to send the webview a frame.
//!
//! This is the piece of `run_tab_loop` that has needed the most fixing, and
//! it needed each fix while inlined among twenty other concerns. It now owns
//! its state and answers one question, which is also what makes it testable.
//!
//! Three mechanisms, each from a different failure:
//!
//! - **Debounce.** Frames are coalesced. A focused tab uses a snappy interval;
//!   an unfocused one backs off hard, because a backgrounded or occluded
//!   window doesn't paint at all (WebKit pauses rAF) — emitting at full rate
//!   there just fills the webview's IPC decode queue with a backlog it has to
//!   drain on refocus, which is what the "frozen for a moment after switching
//!   back" reports were.
//!
//! - **Ack gating.** The webview acks each applied frame; at
//!   `MAX_INFLIGHT_FRAMES` unacked the gate closes. Frames are full snapshots,
//!   so skipping the held-back intermediates is lossless — the freshest one
//!   goes out when the gate reopens. Debouncing alone did not bound anything:
//!   a webview slower than the debounce still accumulated an unbounded
//!   backlog, which showed up as renderer OOM on Windows and refocus freezes
//!   on macOS. `ACK_STALL_FALLBACK` keeps a webview that stops acking
//!   degraded rather than frozen.
//!
//! - **Liveness.** No frame goes to a window that is closing or gone; the tab
//!   loop supplies that verdict from the ownership registry. Pushing frames at
//!   a webview being torn down kept WebKit committing layer trees for a page
//!   whose proxy was already dropped.
//!
//! `pending` is deliberately sticky: a frame withheld for any of these reasons
//! is not lost, it is deferred until the gate opens.

use std::time::{Duration, Instant};

/// Unacked frames tolerated before the gate closes. 2 leaves one frame in
/// flight while the next is being prepared.
const MAX_INFLIGHT_FRAMES: u64 = 2;

/// A webview that stops acking (crashed renderer, wedged JS) would otherwise
/// wedge the gate shut forever. After this long we emit regardless: degraded,
/// not frozen.
const ACK_STALL_FALLBACK: Duration = Duration::from_secs(1);

/// Coalescing interval for a focused tab.
const DEBOUNCE_FOCUSED: Duration = Duration::from_millis(8);

/// …and for an unfocused one, whose window isn't painting anyway.
const DEBOUNCE_UNFOCUSED: Duration = Duration::from_millis(500);

pub struct RenderGate {
    generation: u64,
    acked: u64,
    pending: bool,
    last_emit: Instant,
    focused: bool,
}

impl RenderGate {
    pub fn new(now: Instant) -> Self {
        Self {
            generation: 0,
            acked: 0,
            pending: false,
            last_emit: now,
            focused: true,
        }
    }

    /// Something changed that the webview should see.
    pub fn mark_dirty(&mut self) {
        self.pending = true;
    }

    /// The owning window's focus changed. Refocusing forces an immediate
    /// frame so the tab isn't showing a 500 ms-stale screen when the user
    /// looks at it.
    pub fn set_focused(&mut self, focused: bool) {
        self.focused = focused;
        if focused {
            self.pending = true;
        }
    }

    /// Webview ack. `max` because acks can arrive out of order across the
    /// invoke boundary; the gate only ever moves forward.
    pub fn ack(&mut self, generation: u64) {
        self.acked = self.acked.max(generation);
    }

    fn debounce(&self) -> Duration {
        if self.focused {
            DEBOUNCE_FOCUSED
        } else {
            DEBOUNCE_UNFOCUSED
        }
    }

    /// May a frame go out right now? `alive` is the owning window's verdict
    /// (see `Ownership::emit_target`) — passed in rather than looked up here
    /// so this stays free of the registry.
    pub fn should_emit(&self, now: Instant, alive: bool) -> bool {
        if !self.pending || !alive {
            return false;
        }
        let since = now.saturating_duration_since(self.last_emit);
        if since < self.debounce() {
            return false;
        }
        self.generation - self.acked < MAX_INFLIGHT_FRAMES || since >= ACK_STALL_FALLBACK
    }

    /// Record that a frame is going out, and take its generation number.
    /// Call only after `should_emit` returned true.
    pub fn begin_emit(&mut self, now: Instant) -> u64 {
        self.generation += 1;
        self.pending = false;
        self.last_emit = now;
        self.generation
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A gate with a dirty frame waiting and the debounce already elapsed.
    fn ready() -> (RenderGate, Instant) {
        let t0 = Instant::now();
        let mut g = RenderGate::new(t0);
        g.mark_dirty();
        (g, t0 + Duration::from_millis(50))
    }

    #[test]
    fn nothing_to_send_means_nothing_is_sent() {
        let t0 = Instant::now();
        let g = RenderGate::new(t0);
        assert!(!g.should_emit(t0 + Duration::from_secs(1), true));
    }

    #[test]
    fn a_dead_window_never_gets_a_frame() {
        let (g, now) = ready();
        assert!(!g.should_emit(now, false));
        // …and the frame is not lost: it goes out once the tab is live again.
        assert!(g.should_emit(now, true));
    }

    #[test]
    fn frames_are_coalesced_by_the_debounce() {
        let (mut g, now) = ready();
        let gen = g.begin_emit(now);
        assert_eq!(gen, 1);
        g.ack(gen);
        g.mark_dirty();
        assert!(!g.should_emit(now + Duration::from_millis(4), true));
        assert!(g.should_emit(now + Duration::from_millis(9), true));
    }

    #[test]
    fn an_unfocused_tab_backs_off_hard() {
        let (mut g, now) = ready();
        let gen = g.begin_emit(now);
        g.ack(gen);
        g.set_focused(false);
        g.mark_dirty();
        // What a focused tab would have sent long ago.
        assert!(!g.should_emit(now + Duration::from_millis(100), true));
        assert!(g.should_emit(now + Duration::from_millis(501), true));
    }

    #[test]
    fn refocusing_forces_an_immediate_frame() {
        let (mut g, now) = ready();
        let gen = g.begin_emit(now);
        g.ack(gen);
        g.set_focused(false);
        g.set_focused(true);
        assert!(g.should_emit(now + Duration::from_millis(9), true));
    }

    #[test]
    fn the_gate_shuts_after_max_inflight_unacked_frames() {
        let (mut g, mut now) = ready();
        for _ in 0..MAX_INFLIGHT_FRAMES {
            assert!(g.should_emit(now, true));
            g.begin_emit(now);
            g.mark_dirty();
            now += Duration::from_millis(20);
        }
        // Two in flight, none acked: hold.
        assert!(!g.should_emit(now, true));
        // The withheld frame is still pending and goes the moment one lands.
        g.ack(1);
        assert!(g.should_emit(now, true));
    }

    #[test]
    fn a_webview_that_stops_acking_degrades_rather_than_freezing() {
        let (mut g, mut now) = ready();
        for _ in 0..MAX_INFLIGHT_FRAMES {
            g.begin_emit(now);
            g.mark_dirty();
            now += Duration::from_millis(20);
        }
        assert!(!g.should_emit(now, true));
        assert!(g.should_emit(now + ACK_STALL_FALLBACK, true));
    }

    #[test]
    fn out_of_order_acks_only_move_forward() {
        let (mut g, now) = ready();
        g.begin_emit(now);
        g.begin_emit(now);
        g.ack(2);
        g.ack(1); // late, lower — must not reopen a window that was closed
        assert_eq!(g.acked, 2);
    }
}
