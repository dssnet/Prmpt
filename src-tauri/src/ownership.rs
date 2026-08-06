//! Who owns what: which window each tab belongs to, and which windows are
//! legal to address at all.
//!
//! This used to be spread over three independently-locked maps plus a copy
//! cached inside every tab thread, with three different, non-overlapping ways
//! to ask "may I target this window" (`pool.mode_for`,
//! `TabRegistry::is_window_closing`, `app.get_webview_window(..).is_some()`).
//! No call site consulted all three, so each guard only closed the one race it
//! was written for — and a tab could be handed to a window whose teardown had
//! already taken its snapshot of what to reap, leaving a live thread and a
//! live shell that no window could ever see or close again.
//!
//! Everything now lives under one lock, and `is_attachable` / `may_emit` /
//! `emit_target` are the only questions anyone asks.
//!
//! Deliberately free of `tauri`, `libghostty_vt` and threads: it is plain
//! data, which is what lets the tests at the bottom cover the races that the
//! rest of the lifecycle surface has never had coverage for.

use std::collections::HashMap;

use crate::error::AppError;
use crate::protocol::TabInfo;
use crate::tab::{handle_to_info, TabCmd, TabHandle};

pub type TabId = u64;

/// Lifecycle of a webview window, as far as tab ownership is concerned.
///
/// `Closing` is entered the moment a close is *committed to* — the frontend's
/// `prepare_window_close`, right before it destroys itself — and by the
/// `Destroyed` handler as a backstop. `Gone` only by `Destroyed`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WindowState {
    Live,
    Closing,
    Gone,
}

/// What a window is *for*. A reserve is a hidden, pre-warmed window: it may
/// receive frames (tabs get attached to it during activation) but must never
/// be picked as a drop target, or tabs pile up invisibly on it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WindowKind {
    /// Built, but its frontend hasn't called `bootstrap_window` yet.
    ReserveBuilding,
    /// Bootstrapped and poppable.
    ReserveReady,
    /// An ordinary window the user can see.
    Normal,
}

pub struct WindowRecord {
    pub state: WindowState,
    pub kind: WindowKind,
    pub focused: bool,
}

pub struct TabRecord {
    pub handle: TabHandle,
    pub owner: String,
}

/// Records are never removed — window labels come from a monotonic counter and
/// a destroyed one is never reused, so both maps stay bounded by what this
/// session actually opened.
#[derive(Default)]
pub struct Ownership {
    tabs: HashMap<TabId, TabRecord>,
    windows: HashMap<String, WindowRecord>,
}

/// An applied ownership transfer, kept so it can be undone exactly if the
/// step *after* it fails. See `Ownership::attach_all`.
#[derive(Debug)]
pub struct AttachTxn {
    pub infos: Vec<TabInfo>,
    /// `(tab id, previous owner label)`, in application order.
    prev: Vec<(TabId, String)>,
}

impl Ownership {
    // ---- Windows ---------------------------------------------------------

    pub fn register_window(&mut self, label: &str, kind: WindowKind) {
        self.windows.insert(
            label.to_string(),
            WindowRecord {
                state: WindowState::Live,
                kind,
                focused: false,
            },
        );
    }

    /// THE predicate for "may a tab be moved into this window". An unknown
    /// label is never attachable: a window we were never told about is either
    /// gone or not ours to fill.
    pub fn is_attachable(&self, label: &str) -> bool {
        matches!(
            self.windows.get(label),
            Some(w) if w.state == WindowState::Live && w.kind == WindowKind::Normal
        )
    }

    /// May a tab thread push a render frame / notification at this window?
    /// Wider than `is_attachable`: a reserve is a real, live webview and must
    /// keep painting the tabs handed to it as it is activated.
    ///
    /// Frames pushed at a window past this point are what kept WebKit
    /// committing layer trees for a page being torn down.
    pub fn may_emit(&self, label: &str) -> bool {
        matches!(self.windows.get(label), Some(w) if w.state == WindowState::Live)
    }

    pub fn mark_window_closing(&mut self, label: &str) {
        if let Some(w) = self.windows.get_mut(label) {
            if w.state == WindowState::Live {
                w.state = WindowState::Closing;
            }
        }
    }

    /// The window is gone. Returns the tabs it still owned so the caller can
    /// reap them — one lock acquisition covers both the state flip and the
    /// snapshot, so an attach can't slip in between and hand this window a tab
    /// that nothing will ever reap.
    pub fn mark_window_gone(&mut self, label: &str) -> Vec<TabId> {
        if let Some(w) = self.windows.get_mut(label) {
            w.state = WindowState::Gone;
        } else {
            // Never registered (shouldn't happen), but record the tombstone so
            // it can't later look attachable.
            self.windows.insert(
                label.to_string(),
                WindowRecord {
                    state: WindowState::Gone,
                    kind: WindowKind::Normal,
                    focused: false,
                },
            );
        }
        self.tabs_for_window(label)
    }

    pub fn set_focused(&mut self, label: &str, focused: bool) {
        if let Some(w) = self.windows.get_mut(label) {
            w.focused = focused;
        }
    }

    // ---- Reserve pool ----------------------------------------------------
    //
    // The pool used to keep its own `Empty → Building → Ready → Empty` slot in
    // a second mutex, which could disagree with the window table. The kind
    // *is* the slot now, so "is there already a reserve?" and "claim it" are
    // genuinely one atomic step.

    /// Register `label` as the reserve, unless a live one already exists.
    pub fn claim_reserve(&mut self, label: &str) -> bool {
        if self.live_reserve().is_some() {
            return false;
        }
        self.register_window(label, WindowKind::ReserveBuilding);
        true
    }

    /// `ReserveBuilding → ReserveReady`. False if `label` isn't a building
    /// reserve (already popped, or a different window entirely).
    pub fn mark_reserve_ready(&mut self, label: &str) -> bool {
        match self.windows.get_mut(label) {
            Some(w) if w.kind == WindowKind::ReserveBuilding => {
                w.kind = WindowKind::ReserveReady;
                true
            }
            _ => false,
        }
    }

    /// Take the ready reserve and turn it into a normal window. Also returns
    /// any tabs it had somehow accumulated, so the caller can clear them
    /// before the window is shown.
    pub fn take_ready_reserve(&mut self) -> Option<(String, Vec<TabId>)> {
        let label = self
            .windows
            .iter()
            .find(|(_, w)| w.state == WindowState::Live && w.kind == WindowKind::ReserveReady)
            .map(|(l, _)| l.clone())?;
        if let Some(w) = self.windows.get_mut(&label) {
            w.kind = WindowKind::Normal;
        }
        let stragglers = self.tabs_for_window(&label);
        Some((label, stragglers))
    }

    /// Is this label a reserve (either state)? Drives `WindowMode` at
    /// bootstrap.
    pub fn is_reserve(&self, label: &str) -> bool {
        matches!(
            self.windows.get(label),
            Some(w) if matches!(w.kind, WindowKind::ReserveBuilding | WindowKind::ReserveReady)
        )
    }

    fn live_reserve(&self) -> Option<&String> {
        self.windows
            .iter()
            .find(|(_, w)| {
                w.state == WindowState::Live
                    && matches!(
                        w.kind,
                        WindowKind::ReserveBuilding | WindowKind::ReserveReady
                    )
            })
            .map(|(l, _)| l)
    }

    // ---- Tabs ------------------------------------------------------------

    pub fn insert_tab(&mut self, handle: TabHandle, owner: String) {
        self.tabs.insert(handle.id, TabRecord { handle, owner });
    }

    pub fn remove_tab(&mut self, id: TabId) -> Option<TabRecord> {
        self.tabs.remove(&id)
    }

    pub fn handle(&self, id: TabId) -> Option<&TabHandle> {
        self.tabs.get(&id).map(|r| &r.handle)
    }

    pub fn owner_of(&self, id: TabId) -> Option<&str> {
        self.tabs.get(&id).map(|r| r.owner.as_str())
    }

    pub fn info(&self, id: TabId) -> Option<TabInfo> {
        self.tabs.get(&id).map(|r| handle_to_info(&r.handle))
    }

    /// Ids owned by `label`, ascending. Ids are monotonic, so that is spawn
    /// order — which is what makes a window's hydration deterministic.
    pub fn tabs_for_window(&self, label: &str) -> Vec<TabId> {
        let mut ids: Vec<TabId> = self
            .tabs
            .iter()
            .filter(|(_, r)| r.owner == label)
            .map(|(id, _)| *id)
            .collect();
        ids.sort_unstable();
        ids
    }

    pub fn all_infos(&self) -> Vec<TabInfo> {
        self.tabs.values().map(|r| handle_to_info(&r.handle)).collect()
    }

    /// Where a tab's frames should go, or `None` if it has no owner or its
    /// owner can't take frames any more. One query, one lock acquisition —
    /// which is what keeps the gate and the emit target from disagreeing.
    pub fn emit_target(&self, id: TabId) -> Option<String> {
        let owner = self.owner_of(id)?;
        self.may_emit(owner).then(|| owner.to_string())
    }

    /// Move every named tab to `target`, or nothing at all.
    ///
    /// Validation happens before the first mutation: the previous version
    /// mutated first and reported the failure afterwards, so a target window
    /// that closed mid-drag left the tab stranded — owned by a dead label, out
    /// of reach of every window, with its shell still running.
    ///
    /// An empty `ids` is a legal no-op that still validates the target: that
    /// is how an all-panel move (which names no backend tab at all) gets a
    /// liveness check it never had.
    pub fn attach_all(&mut self, ids: &[TabId], target: &str) -> Result<AttachTxn, AppError> {
        if !self.is_attachable(target) {
            return Err(AppError::WindowUnavailable(target.to_string()));
        }
        for id in ids {
            if !self.tabs.contains_key(id) {
                return Err(AppError::UnknownTab(*id));
            }
        }
        let mut txn = AttachTxn {
            infos: Vec::with_capacity(ids.len()),
            prev: Vec::with_capacity(ids.len()),
        };
        for id in ids {
            let rec = self.tabs.get_mut(id).expect("validated above");
            let was = std::mem::replace(&mut rec.owner, target.to_string());
            txn.prev.push((*id, was));
            txn.infos.push(handle_to_info(&rec.handle));
            // Unbounded channel: never blocks, so holding the lock is safe.
            // The tab thread only needs to know its owner changed — it reads
            // the actual target back out of here on its next frame.
            let _ = rec.handle.cmd_tx.send(TabCmd::OwnerChanged);
        }
        Ok(txn)
    }

    /// Undo an `attach_all` exactly, for when the step after it fails.
    pub fn rollback_attach(&mut self, txn: &AttachTxn) {
        for (id, prev) in &txn.prev {
            if let Some(rec) = self.tabs.get_mut(id) {
                rec.owner = prev.clone();
                let _ = rec.handle.cmd_tx.send(TabCmd::OwnerChanged);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crossbeam_channel::{unbounded, Receiver};
    use parking_lot::Mutex;

    use super::*;
    use crate::tab::TabKind;

    fn handle(id: TabId) -> (TabHandle, Receiver<TabCmd>) {
        let (tx, rx) = unbounded();
        (
            TabHandle {
                id,
                cmd_tx: tx,
                kind: TabKind::Local,
                host_id: None,
                host_label: None,
                disable_sftp: false,
                disable_ssh: false,
                shell_pid: None,
                osc_cwd: Arc::new(Mutex::new(None)),
            },
            rx,
        )
    }

    /// A window `w` with tabs 1 and 2 in it.
    fn fixture() -> (Ownership, Vec<Receiver<TabCmd>>) {
        let mut o = Ownership::default();
        o.register_window("w", WindowKind::Normal);
        o.register_window("other", WindowKind::Normal);
        let mut rxs = Vec::new();
        for id in [1, 2] {
            let (h, rx) = handle(id);
            o.insert_tab(h, "w".into());
            rxs.push(rx);
        }
        (o, rxs)
    }

    #[test]
    fn unknown_window_is_never_a_target() {
        let (o, _) = fixture();
        assert!(!o.is_attachable("nope"));
        assert!(!o.may_emit("nope"));
    }

    #[test]
    fn closing_and_gone_windows_reject_attach_and_emit() {
        let (mut o, _) = fixture();
        o.mark_window_closing("w");
        assert!(!o.is_attachable("w"));
        assert!(!o.may_emit("w"));
        o.mark_window_gone("w");
        assert!(!o.is_attachable("w"));
        assert!(!o.may_emit("w"));
    }

    #[test]
    fn reserve_is_not_attachable_but_may_emit() {
        let mut o = Ownership::default();
        o.register_window("r", WindowKind::ReserveReady);
        assert!(!o.is_attachable("r"));
        assert!(o.may_emit("r"));
    }

    #[test]
    fn attach_all_is_atomic_on_an_unknown_id() {
        let (mut o, rxs) = fixture();
        let err = o.attach_all(&[1, 99, 2], "other").unwrap_err();
        assert!(matches!(err, AppError::UnknownTab(99)));
        assert_eq!(o.owner_of(1), Some("w"));
        assert_eq!(o.owner_of(2), Some("w"));
        // Nothing was signalled either — the tabs never learned of a move.
        assert!(rxs.iter().all(|rx| rx.is_empty()));
    }

    #[test]
    fn attach_all_is_atomic_on_a_dead_target() {
        let (mut o, rxs) = fixture();
        o.mark_window_gone("other");
        let err = o.attach_all(&[1, 2], "other").unwrap_err();
        assert!(matches!(err, AppError::WindowUnavailable(_)));
        assert_eq!(o.owner_of(1), Some("w"));
        assert!(rxs.iter().all(|rx| rx.is_empty()));
    }

    #[test]
    fn attach_all_moves_everything_and_signals_once_each() {
        let (mut o, rxs) = fixture();
        let txn = o.attach_all(&[1, 2], "other").unwrap();
        assert_eq!(txn.infos.len(), 2);
        assert_eq!(o.owner_of(1), Some("other"));
        assert_eq!(o.owner_of(2), Some("other"));
        for rx in &rxs {
            assert!(matches!(rx.try_recv(), Ok(TabCmd::OwnerChanged)));
            assert!(rx.is_empty());
        }
    }

    #[test]
    fn empty_attach_still_validates_the_target() {
        // The all-panel move: no backend tab to name, but the window still
        // has to be alive to receive the tree.
        let (mut o, _) = fixture();
        assert!(o.attach_all(&[], "other").is_ok());
        o.mark_window_gone("other");
        assert!(o.attach_all(&[], "other").is_err());
    }

    #[test]
    fn rollback_restores_the_previous_owners() {
        let mut o = Ownership::default();
        o.register_window("a", WindowKind::Normal);
        o.register_window("b", WindowKind::Normal);
        o.register_window("c", WindowKind::Normal);
        let (h1, _r1) = handle(1);
        let (h2, _r2) = handle(2);
        o.insert_tab(h1, "a".into());
        o.insert_tab(h2, "b".into());

        let txn = o.attach_all(&[1, 2], "c").unwrap();
        o.rollback_attach(&txn);
        // Each tab goes back to where it came from, not to a common origin.
        assert_eq!(o.owner_of(1), Some("a"));
        assert_eq!(o.owner_of(2), Some("b"));
    }

    #[test]
    fn a_destroyed_window_hands_back_its_tabs_and_stays_shut() {
        let (mut o, _) = fixture();
        let mut orphans = o.mark_window_gone("w");
        orphans.sort_unstable();
        assert_eq!(orphans, vec![1, 2]);
        // The race this closes: an attach landing after the reap snapshot
        // used to succeed and strand the tab forever.
        assert!(o.attach_all(&[1], "w").is_err());
    }

    #[test]
    fn emit_target_follows_the_owner_and_stops_at_closing() {
        let (mut o, _) = fixture();
        assert_eq!(o.emit_target(1).as_deref(), Some("w"));
        o.attach_all(&[1], "other").unwrap();
        assert_eq!(o.emit_target(1).as_deref(), Some("other"));
        o.mark_window_closing("other");
        assert_eq!(o.emit_target(1), None);
        assert_eq!(o.emit_target(404), None);
    }

    #[test]
    fn tabs_for_window_is_ordered_and_scoped() {
        let (mut o, _) = fixture();
        let (h3, _r3) = handle(3);
        o.insert_tab(h3, "other".into());
        assert_eq!(o.tabs_for_window("w"), vec![1, 2]);
        assert_eq!(o.tabs_for_window("other"), vec![3]);
        assert!(o.tabs_for_window("nobody").is_empty());
    }

    #[test]
    fn reserve_slot_admits_exactly_one_at_a_time() {
        let mut o = Ownership::default();
        assert!(o.claim_reserve("r1"));
        // A second claim while one is live is the double-build race.
        assert!(!o.claim_reserve("r2"));
        // Not poppable until its frontend bootstrapped.
        assert!(o.take_ready_reserve().is_none());
        assert!(o.mark_reserve_ready("r1"));
        let (label, stragglers) = o.take_ready_reserve().unwrap();
        assert_eq!(label, "r1");
        assert!(stragglers.is_empty());
        // Popped: now an ordinary window, and the slot is free again.
        assert!(o.is_attachable("r1"));
        assert!(!o.is_reserve("r1"));
        assert!(o.claim_reserve("r2"));
    }

    #[test]
    fn a_destroyed_reserve_frees_the_slot() {
        let mut o = Ownership::default();
        assert!(o.claim_reserve("r1"));
        o.mark_window_gone("r1");
        assert!(o.claim_reserve("r2"));
    }

    #[test]
    fn mark_reserve_ready_ignores_strangers() {
        let mut o = Ownership::default();
        o.register_window("w", WindowKind::Normal);
        assert!(!o.mark_reserve_ready("w"));
        assert!(!o.mark_reserve_ready("never-seen"));
        assert!(o.is_attachable("w"));
    }

    #[test]
    fn take_ready_reserve_reports_stragglers_for_reaping() {
        let mut o = Ownership::default();
        assert!(o.claim_reserve("r"));
        assert!(o.mark_reserve_ready("r"));
        let (h, _rx) = handle(9);
        o.insert_tab(h, "r".into());
        let (label, stragglers) = o.take_ready_reserve().unwrap();
        assert_eq!(label, "r");
        assert_eq!(stragglers, vec![9]);
    }
}
