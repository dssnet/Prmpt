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

/// Args that turn `shell` into a *login* shell so it sources the user's
/// profile (`~/.zprofile`, `~/.bash_profile`, …) and therefore the real
/// `PATH`. A PTY-attached shell with no command argument is already
/// *interactive*; this only adds the *login* part. Returned only for
/// shells we know accept `-l`; anything else (pwsh/cmd/unknown) is a
/// no-op so we never feed a flag a shell will choke on.
///
/// Why this matters: a GUI-launched `.app` inherits `launchd`'s minimal
/// `PATH`, so without a login shell `code`, Homebrew binaries, etc. are
/// not found.
pub fn login_shell_args(shell_path: &str) -> &'static [&'static str] {
    let name = std::path::Path::new(shell_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    match name {
        "zsh" | "bash" | "fish" | "sh" | "dash" | "ksh" => &["-l"],
        _ => &[],
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
