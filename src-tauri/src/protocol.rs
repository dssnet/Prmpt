use serde::Serialize;

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
}

#[derive(Serialize, Clone, Debug)]
pub struct ExitPayload {
    pub tab_id: u64,
    pub status: i32,
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
