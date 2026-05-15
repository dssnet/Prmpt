//! Per-OS helpers. Keep platform-specific decisions in this file so the
//! rest of the backend can stay target-agnostic.
//!
//! What lives here:
//! - `default_shell` — which binary to spawn for a new local terminal.
//! - `home_dir` — the working directory to drop the shell into.
//! - `title_bar_style` / `hidden_title` — window chrome customizations
//!   that only do anything on macOS but are accepted by Tauri's window
//!   builder on every platform.

use std::path::PathBuf;

#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

/// Path to the binary `spawn_tab` should exec. On Unix we honor `SHELL`
/// (the convention every interactive program follows) and fall back to
/// `/bin/sh` which POSIX guarantees. On Windows we prefer PowerShell 7
/// (`pwsh.exe`) if it's on `PATH`, otherwise Windows PowerShell, then
/// `cmd.exe`.
pub fn default_shell() -> String {
    #[cfg(unix)]
    {
        if let Ok(s) = std::env::var("SHELL") {
            if !s.is_empty() {
                return s;
            }
        }
        "/bin/sh".to_string()
    }

    #[cfg(windows)]
    {
        if let Some(p) = which("pwsh.exe") {
            return p;
        }
        if let Some(p) = which("powershell.exe") {
            return p;
        }
        std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".to_string())
    }
}

/// Returns the user's home directory, or `None` if the OS can't resolve
/// one. Wraps the `directories` crate so we don't grow another path
/// abstraction.
pub fn home_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|d| d.home_dir().to_path_buf())
}

/// macOS overlay titlebar (titlebar blended into the window's content
/// view). The `title_bar_style` / `hidden_title` builder methods only
/// exist on macOS in Tauri 2; call sites must `#[cfg(target_os =
/// "macos")]` around their use of these helpers.
#[cfg(target_os = "macos")]
pub fn title_bar_style() -> TitleBarStyle {
    TitleBarStyle::Overlay
}

#[cfg(target_os = "macos")]
pub fn hidden_title() -> bool {
    true
}

#[cfg(windows)]
fn which(exe: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}
