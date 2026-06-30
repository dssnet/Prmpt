use serde::{Deserialize, Serialize};

use crate::window_pool::WindowMode;

pub const FLAG_BOLD: u8 = 1 << 0;
pub const FLAG_ITALIC: u8 = 1 << 1;
pub const FLAG_UNDERLINE: u8 = 1 << 2;
pub const FLAG_INVERSE: u8 = 1 << 3;
pub const FLAG_FAINT: u8 = 1 << 4;
pub const FLAG_STRIKETHROUGH: u8 = 1 << 5;
pub const FLAG_WIDE: u8 = 1 << 6;
pub const FLAG_SPACER_TAIL: u8 = 1 << 7;

#[derive(Serialize, Clone, Debug)]
pub struct CellWire {
    pub ch: u32,
    pub fg: u32,
    pub bg: u32,
    pub flags: u8,
}

/// One run of cells covered by an OSC 8 hyperlink. `row` is viewport-relative,
/// `c0..=c1` the inclusive column range, `link` an index into
/// `RenderPayload::links`. Spans (rather than a per-cell field) keep the
/// common no-links payload size unchanged.
#[derive(Serialize, Clone, Debug)]
pub struct LinkSpanWire {
    pub row: u16,
    pub c0: u16,
    pub c1: u16,
    pub link: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct CursorWire {
    pub x: u16,
    pub y: u16,
    pub visible: bool,
    pub style: u8,
    pub blinking: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct RenderPayload {
    pub tab_id: u64,
    pub cols: u16,
    pub rows: u16,
    pub default_fg: u32,
    pub default_bg: u32,
    pub cells: Vec<CellWire>,
    pub cursor: Option<CursorWire>,
    pub generation: u64,
    pub title: String,
    /// Screen-absolute row index of viewport row 0. Equal to the scrollbar's
    /// offset — `viewport_top + row` gives a coordinate stable across resize
    /// and scrolling so the frontend can pin selection to content rather than
    /// to a viewport slot.
    pub viewport_top: u64,
    /// Total scrollable rows (scrollback + visible viewport). The scrollbar
    /// thumb spans `rows / scrollback_total` of the track, and the visible
    /// region starts at `viewport_top / (scrollback_total - rows)` along it.
    pub scrollback_total: u64,
    /// Current kitty keyboard protocol flags (bit 1 = disambiguate, bit 2 =
    /// report events, …). Key encoding happens on the backend, so this is
    /// purely a traffic hint: the frontend skips forwarding key-release and
    /// bare-modifier events the encoder would discard anyway.
    pub kitty_flags: u8,
    /// Whether the application currently has any mouse-tracking mode active
    /// (X10 / normal / button / any). Like `kitty_flags`, this is a traffic
    /// hint: the frontend uses it to decide whether to forward mouse events to
    /// the PTY (`write_mouse`) and suppress its own text selection, or fall
    /// back to local selection. Encoding itself happens on the backend.
    pub mouse_tracking: bool,
    /// Deduped OSC 8 hyperlink URIs visible this frame.
    pub links: Vec<String>,
    /// Cell runs covered by those hyperlinks (viewport coordinates).
    pub link_spans: Vec<LinkSpanWire>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ExitPayload {
    pub tab_id: u64,
    pub status: i32,
}

/// Answer to `tab_foreground_process`: the process group currently in the
/// foreground of a local tab's PTY, when it isn't the shell we spawned —
/// i.e. "something is running in this tab". `None`-command result (no
/// payload at all) means idle shell, SSH tab, or a platform where the
/// check isn't available (Windows).
#[derive(Serialize, Clone, Debug)]
pub struct ForegroundProcess {
    pub pid: i32,
    /// Short executable name (e.g. "claude"), when the OS could resolve it.
    pub name: Option<String>,
}

/// A keyboard event as the webview saw it, encoded on the tab thread by
/// libghostty-vt's key encoder against the terminal's live modes (DECCKM,
/// keypad mode, kitty keyboard flags, …). Field names mirror the W3C
/// `KeyboardEvent` concepts they're lifted from.
#[derive(Deserialize, Clone, Debug)]
pub struct KeyEventWire {
    /// DOM `KeyboardEvent.code` (physical key, e.g. "KeyA", "ArrowUp").
    pub code: String,
    /// "press" | "release" | "repeat".
    pub action: String,
    /// Text the key produced for the current layout (DOM `key` when it's a
    /// single printable grapheme), pre-Ctrl/Meta transformation. `None` for
    /// named keys — the encoder derives those from `code`.
    pub utf8: Option<String>,
    /// Codepoint of the key without shift applied (0 when not applicable).
    pub unshifted_codepoint: u32,
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub super_key: bool,
    pub caps_lock: bool,
    pub num_lock: bool,
}

/// A mouse event from the webview, encoded on the tab thread by libghostty-vt's
/// mouse encoder against the terminal's live tracking mode / output format
/// (X10, SGR, urxvt, …). Only forwarded to the PTY when an application has
/// mouse tracking on; the encoder self-filters events a mode doesn't report.
/// Position is in viewport-relative cell coordinates (0-based).
#[derive(Deserialize, Clone, Debug)]
pub struct MouseEventWire {
    /// "press" | "release" | "motion".
    pub action: String,
    /// Button identity: 0 = left, 1 = middle, 2 = right, 3 = wheel-up (four),
    /// 4 = wheel-down (five). 255 = none (motion with no button held).
    pub button: u8,
    /// Pointer column (cell), viewport-relative.
    pub col: u16,
    /// Pointer row (cell), viewport-relative.
    pub row: u16,
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

/// `terminal:notification` — a program rang the bell (BEL) or sent an OSC
/// 9 / OSC 777 desktop notification (how Claude Code announces a finished
/// task). Throttled to one per second per tab on the backend.
#[derive(Serialize, Clone, Debug)]
pub struct NotifyPayload {
    pub tab_id: u64,
    /// "bell" | "osc".
    pub source: String,
    pub title: Option<String>,
    pub body: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct TabInfo {
    pub id: u64,
    pub title: String,
    /// "terminal" for local PTY tabs, "ssh" for SSH-backed tabs.
    pub kind: String,
    /// Populated for SSH tabs so a window that just hydrated/attached the
    /// tab can render the host label without having to wait for the first
    /// render payload to refresh the tab bar.
    pub host_id: Option<i64>,
    pub host_label: Option<String>,
    /// SSH per-host flags, carried so hydrate/tear-off restores the right
    /// tab chrome (SFTP side panel suppressed / full-width file browser).
    /// Always `false` for local tabs.
    pub disable_sftp: bool,
    pub disable_ssh: bool,
}

pub const CURSOR_STYLE_BLOCK: u8 = 0;
pub const CURSOR_STYLE_BAR: u8 = 1;
pub const CURSOR_STYLE_UNDERLINE: u8 = 2;
pub const CURSOR_STYLE_BLOCK_HOLLOW: u8 = 3;

/// Returned by `bootstrap_window` so the frontend knows whether it should
/// proceed with the normal hydrate/spawn path or sit idle as a pre-warmed
/// reserve waiting for an activation.
#[derive(Serialize, Clone, Debug)]
pub struct WindowBootstrap {
    pub mode: WindowMode,
    pub tabs: Vec<TabInfo>,
}

#[derive(Serialize, Clone, Debug)]
pub struct SshHostKeyMismatch {
    pub tab_id: u64,
    pub host_id: i64,
    pub stored_fp: String,
    pub received_fp: String,
    pub algorithm: String,
}

/// One entry in a local-filesystem directory listing. Mirrors [`SftpEntry`]
/// but for the machine's own filesystem; metadata is best-effort (a broken
/// symlink or a permission-denied entry may have no `size`/`mtime`).
#[derive(Serialize, Clone, Debug)]
pub struct LocalEntry {
    pub name: String,
    /// Absolute path (the listed directory joined with `name`). The frontend
    /// never has to join paths itself — sidesteps separator differences.
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// mtime in epoch seconds, when the OS reports it.
    pub mtime: Option<i64>,
    /// Creation time in epoch seconds. Native on Windows (CreationTime) and
    /// macOS (birthtime); on Linux it needs statx + a filesystem that stores
    /// btime (ext4/btrfs/xfs do), otherwise `None`.
    pub created: Option<i64>,
}

/// One filesystem root the user can switch to from the browser's drive picker.
/// `name` is a short label (a drive letter like `C:` on Windows, or the volume
/// folder name on macOS/Linux); `path` is the root directory to navigate to.
#[derive(Serialize, Clone, Debug)]
pub struct LocalDrive {
    pub name: String,
    pub path: String,
}

/// A local directory listing: the canonical directory, its parent (`None` at a
/// filesystem root), and the sorted entries. `parent` drives the browser's Up
/// button without the frontend having to reason about path separators.
#[derive(Serialize, Clone, Debug)]
pub struct LocalListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<LocalEntry>,
}

/// Result of resolving a directory for the git panel: distinguishes "this
/// machine has no git" and "this directory isn't inside a repo" (both normal
/// empty states the panel renders) from an actual repo snapshot.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GitRepoStatus {
    GitMissing,
    NotARepo,
    Repo(GitStatusSnapshot),
}

/// `git status --porcelain=v2 --branch` distilled for the panel: branch info
/// plus the working-tree changes split into the index (`staged`) and the
/// worktree (`unstaged`, which includes untracked files). A file modified in
/// both places appears in both lists.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GitStatusSnapshot {
    /// Canonical repo toplevel — every other git command takes this, and the
    /// file paths below are relative to it.
    pub root: String,
    /// `None` when HEAD is detached (see `detached_at`) or the repo is empty.
    pub branch: Option<String>,
    /// Short hash shown instead of a branch name while detached.
    pub detached_at: Option<String>,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub staged: Vec<GitFileEntry>,
    pub unstaged: Vec<GitFileEntry>,
}

/// One changed file. `status` is a stable lowercase word
/// ("modified"|"added"|"deleted"|"renamed"|"copied"|"typechange"|"untracked"|
/// "conflicted") rather than git's letter codes, so the frontend never parses
/// porcelain output.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GitFileEntry {
    /// Repo-relative path.
    pub path: String,
    /// Rename/copy source, when `status` is "renamed"/"copied".
    pub orig_path: Option<String>,
    pub status: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GitCommit {
    pub hash: String,
    pub author: String,
    /// Author time in epoch seconds.
    pub time: i64,
    pub subject: String,
}

/// Emitted on a TOFU first connect — the host had no stored fingerprint,
/// the handler accepted whatever the server sent, and now the frontend
/// should persist `fingerprint` against `host_id` via the SQL plugin.
#[derive(Serialize, Clone, Debug)]
pub struct SshHostKeyFirstConnect {
    pub tab_id: u64,
    pub host_id: i64,
    pub fingerprint: String,
    pub algorithm: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct SshPortForwardError {
    pub tab_id: u64,
    pub host_id: i64,
    pub forward_id: Option<i64>,
    pub message: String,
}

/// One entry in an SFTP directory listing. All metadata is best-effort:
/// the server may omit any field, so `size`/`mtime`/`mode` are optional and
/// default to "unknown" on the frontend.
#[derive(Serialize, Clone, Debug)]
pub struct SftpEntry {
    pub name: String,
    /// Absolute remote path (`dir` joined with `name`).
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Unix mtime in epoch seconds, when the server reports it.
    pub mtime: Option<u64>,
    /// Unix permission bits, when the server reports them.
    pub mode: Option<u32>,
}

/// Emitted once per connect attempt when the SFTP subsystem is (or isn't)
/// ready: the panel mounts before the SSH handshake completes, so it waits
/// for `available: true` to load — and reloads on each reconnect. `available:
/// false` means the server didn't offer the subsystem.
#[derive(Serialize, Clone, Debug)]
pub struct SftpAvailability {
    pub tab_id: u64,
    pub available: bool,
}

/// Progress for an in-flight SFTP upload/download, emitted per chunk so the
/// panel can render a progress bar. `total` is `None` when the size isn't
/// known up front (rare; uploads always know it from the local file).
#[derive(Serialize, Clone, Debug)]
pub struct SftpTransferProgress {
    pub tab_id: u64,
    /// Frontend-supplied transfer id so concurrent transfers are distinguishable.
    pub transfer_id: u64,
    pub transferred: u64,
    pub total: Option<u64>,
    /// True on the final emit (success or error); `error` is set on failure.
    pub done: bool,
    pub error: Option<String>,
}

/// Emitted whenever a working session drops and the task is about to retry.
/// Shell tabs already show the "connection lost — reconnecting…" banner in
/// the terminal; SFTP-only tabs have no visible VT, so the frontend listens
/// for this and surfaces a toast instead.
#[derive(Serialize, Clone, Debug)]
pub struct SshReconnecting {
    pub tab_id: u64,
    pub host_id: i64,
    pub host_label: String,
}

/// Emitted on every successful (re)connect, right when the shell/SFTP
/// channels are up. The frontend uses it to clear the per-tab
/// "reconnecting" state set by `SshReconnecting` (which gates the
/// Ctrl+C-cancels-reconnect shortcut).
#[derive(Serialize, Clone, Debug)]
pub struct SshConnected {
    pub tab_id: u64,
    pub host_id: i64,
    pub host_label: String,
}

/// Emitted when the SSH session task could not establish or sustain a
/// connection — wraps the bubbled-up error so the frontend can show a
/// dismissable dialog (otherwise the tab just disappears and the user
/// has no chance to read the error written to the PTY).
#[derive(Serialize, Clone, Debug)]
pub struct SshConnectError {
    pub tab_id: u64,
    pub host_id: i64,
    pub host_label: String,
    pub hostname: String,
    pub message: String,
    /// Coarse classification so the frontend can pick a good title.
    /// One of: "connect", "auth", "channel", "other".
    pub kind: String,
}
