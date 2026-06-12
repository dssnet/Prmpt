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
        if let Some(p) = find_on_path("pwsh.exe") {
            return p;
        }
        if let Some(p) = find_on_path("powershell.exe") {
            return p;
        }
        std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".to_string())
    }
}

/// Pick the shell binary `spawn_tab` should exec from the (optional)
/// configured value. `None` (the default) defers to [`default_shell`].
///
/// A configured shell is honored only if it's actually runnable here:
/// either an existing file (absolute/relative path) or a bare command
/// name we can find on `PATH`. Anything else — most importantly a path
/// from a *different* OS that rode in via an imported backup (e.g.
/// `C:\Windows\System32\cmd.exe` on macOS) — is discarded in favor of
/// the platform default rather than handed to the PTY, where it would
/// fail the tab spawn outright.
pub fn resolve_shell(configured: Option<String>) -> String {
    let Some(s) = configured else {
        return default_shell();
    };
    let usable = std::path::Path::new(&s).is_file()
        // A bare command name (no path separator) resolves via PATH at
        // exec time; accept it if we can locate it, so PATH-relative
        // configs keep working.
        || (!s.contains('/') && !s.contains('\\') && find_on_path(&s).is_some());
    if usable {
        return s;
    }
    let default = default_shell();
    eprintln!("[tab] configured shell {s:?} not found; falling back to {default:?}");
    default
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

/// Identity markers of whatever terminal launched *us* (a dev run from
/// Ghostty/iTerm, `bun tauri dev` inside VS Code, …). If they leak into
/// the child shell, programs that sniff them — Claude Code, shell
/// prompts, anything doing terminal feature detection — believe they're
/// running inside that *other* terminal and target its exact feature
/// set. The child's terminal is Prmpt; scrub everyone else's calling
/// cards. (tab.rs then sets TERM_PROGRAM=ghostty deliberately: we run
/// Ghostty's VT engine and key encoder, so advertising as Ghostty is
/// accurate enough and is what makes Claude Code emit OSC 777
/// completion notifications.)
const FOREIGN_TERMINAL_VARS: &[&str] = &[
    // Generic (Terminal.app, Ghostty, iTerm2, VS Code all set these)
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "TERM_SESSION_ID",
    // Ghostty
    "GHOSTTY_RESOURCES_DIR",
    "GHOSTTY_BIN_DIR",
    // kitty
    "KITTY_WINDOW_ID",
    "KITTY_PID",
    "KITTY_PUBLIC_KEY",
    "KITTY_INSTALLATION_DIR",
    "KITTY_LISTEN_ON",
    // iTerm2 (LC_TERMINAL is its ssh-forwarded identity)
    "ITERM_SESSION_ID",
    "ITERM_PROFILE",
    "LC_TERMINAL",
    "LC_TERMINAL_VERSION",
    // WezTerm
    "WEZTERM_EXECUTABLE",
    "WEZTERM_EXECUTABLE_DIR",
    "WEZTERM_CONFIG_DIR",
    "WEZTERM_CONFIG_FILE",
    "WEZTERM_PANE",
    "WEZTERM_UNIX_SOCKET",
    // Alacritty
    "ALACRITTY_SOCKET",
    "ALACRITTY_LOG",
    "ALACRITTY_WINDOW_ID",
    // Konsole / VTE-based (GNOME Terminal, …)
    "KONSOLE_VERSION",
    "KONSOLE_DBUS_SESSION",
    "KONSOLE_DBUS_SERVICE",
    "KONSOLE_DBUS_WINDOW",
    "VTE_VERSION",
    "GNOME_TERMINAL_SCREEN",
    "GNOME_TERMINAL_SERVICE",
    // Windows Terminal
    "WT_SESSION",
    "WT_PROFILE_ID",
    // Multiplexers: the child is not inside the parent's tmux/screen
    "TMUX",
    "TMUX_PANE",
    "STY",
    // X11 window id of the launching terminal
    "WINDOWID",
];

/// Strip AppImage-injected variables from a child command's environment.
///
/// The AppImage runtime / linuxdeploy `AppRun` *prepends* `$APPDIR/...`
/// onto `LD_LIBRARY_PATH` and a swarm of GTK/GIO/GdkPixbuf/typelib path
/// vars before our process even starts, keeping the user's original
/// value as the suffix. Those bundled libs (older glib/gio, …) are
/// correct for *our* webview but poison for arbitrary programs the user
/// runs in the terminal: e.g. `flatpak` loads the host
/// `libmalcontent-0.so.0`, which then resolves `g_task_set_static_name`
/// against our bundled GLib < 2.76 and dies with "undefined symbol".
/// The .deb/.rpm builds set none of this, so their shells are clean;
/// the terminal must hand its child the same login-grade environment.
///
/// Because `AppRun` only prepends `$APPDIR` entries, the original is
/// recoverable exactly: drop the entries under `$APPDIR`, keep the
/// rest. No-op when not launched from an AppImage (`APPDIR` unset) and
/// on non-Linux targets.
#[cfg(all(not(target_os = "ios"), not(target_os = "android")))]
pub fn sanitize_child_env(cmd: &mut portable_pty::CommandBuilder) {
    for var in FOREIGN_TERMINAL_VARS {
        cmd.env_remove(var);
    }

    #[cfg(target_os = "linux")]
    {
        let appdir = match std::env::var("APPDIR") {
            Ok(d) if !d.is_empty() => d,
            _ => return,
        };

        // Colon-separated search paths: keep only non-$APPDIR entries;
        // unset entirely if nothing host-side remains (so the child
        // gets the system default, not an empty override).
        const PATH_LIST_VARS: &[&str] = &[
            "LD_LIBRARY_PATH",
            "XDG_DATA_DIRS",
            "XDG_CONFIG_DIRS",
            "GI_TYPELIB_PATH",
            "GTK_PATH",
            "GIO_MODULE_DIR",
            "GIO_EXTRA_MODULES",
            "GSETTINGS_SCHEMA_DIR",
            "QT_PLUGIN_PATH",
            "GST_PLUGIN_SYSTEM_PATH",
            "GST_PLUGIN_SYSTEM_PATH_1_0",
            "GST_PLUGIN_PATH",
            "GST_PLUGIN_PATH_1_0",
            "PYTHONPATH",
            "PERLLIB",
            "PERL5LIB",
        ];
        for var in PATH_LIST_VARS {
            let Ok(val) = std::env::var(var) else { continue };
            let kept: Vec<&str> = val
                .split(':')
                .filter(|e| !e.is_empty() && !is_under(e, &appdir))
                .collect();
            if kept.is_empty() {
                cmd.env_remove(var);
            } else {
                cmd.env(var, kept.join(":"));
            }
        }

        // Single-value vars pointing at a file/dir inside the bundle.
        const SINGLE_VARS: &[&str] = &[
            "GDK_PIXBUF_MODULE_FILE",
            "GDK_PIXBUF_MODULEDIR",
            "GTK_EXE_PREFIX",
            "GTK_DATA_PREFIX",
            "GTK_IM_MODULE_FILE",
            "FONTCONFIG_FILE",
            "FONTCONFIG_PATH",
            "LIBGL_DRIVERS_PATH",
            "PYTHONHOME",
        ];
        for var in SINGLE_VARS {
            if let Ok(val) = std::env::var(var) {
                if is_under(&val, &appdir) {
                    cmd.env_remove(var);
                }
            }
        }

        // LD_PRELOAD is space- or colon-separated; just drop it whole
        // if it references the bundle at all.
        if let Ok(val) = std::env::var("LD_PRELOAD") {
            if val.contains(&appdir) {
                cmd.env_remove("LD_PRELOAD");
            }
        }

        // Don't let the child believe it's running inside an AppImage.
        for var in ["APPDIR", "APPIMAGE", "APPIMAGE_UUID", "ARGV0", "OWD"] {
            cmd.env_remove(var);
        }
    }
}

/// True if `entry` is `appdir` itself or a path beneath it. `AppRun`
/// uses literal `$APPDIR` prefixes, so a string prefix test is exact;
/// tolerate a trailing-slash mismatch on either side.
#[cfg(target_os = "linux")]
fn is_under(entry: &str, appdir: &str) -> bool {
    let e = entry.trim_end_matches('/');
    let a = appdir.trim_end_matches('/');
    e == a || e.starts_with(&format!("{a}/"))
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

/// Turn off WebView2's native "Saved Information" autofill dropdown.
///
/// WebView2 ignores the `autocomplete="off"` HTML attribute for its
/// general-autofill UI (`main.ts` sets that attribute on every input, but
/// the Edge "Saved Information" suggestion box appears anyway), so the only
/// way to suppress it is the native settings interface. Disables both the
/// general-form autofill (the dropdown) and password autosave. No-op
/// anywhere but Windows.
#[cfg(target_os = "windows")]
pub fn disable_webview2_autofill(webview: &tauri::webview::PlatformWebview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
    use windows_core::Interface;
    unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let Ok(settings) = core.Settings() else {
            return;
        };
        let Ok(settings4) = settings.cast::<ICoreWebView2Settings4>() else {
            return;
        };
        let _ = settings4.SetIsGeneralAutofillEnabled(false.into());
        let _ = settings4.SetIsPasswordAutosaveEnabled(false.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn none_uses_platform_default() {
        assert_eq!(resolve_shell(None), default_shell());
    }

    #[cfg(unix)]
    #[test]
    fn existing_absolute_path_passes_through() {
        // /bin/sh is guaranteed by POSIX, so it must be honored verbatim.
        assert_eq!(resolve_shell(Some("/bin/sh".into())), "/bin/sh");
    }

    #[cfg(unix)]
    #[test]
    fn foreign_path_falls_back_to_default() {
        // A Windows shell path that rode in via an imported backup is not a
        // file here and not on PATH → must fall back, not reach the PTY.
        let resolved = resolve_shell(Some(r"C:\Windows\System32\cmd.exe".into()));
        assert_eq!(resolved, default_shell());
        assert_ne!(resolved, r"C:\Windows\System32\cmd.exe");
    }

    /// Validates the hand-declared `proc_vnodepathinfo` layout on macOS (and
    /// the procfs path on Linux) against ground truth: our own process.
    #[cfg(unix)]
    #[test]
    fn process_cwd_resolves_own_process() {
        let cwd = process_cwd(std::process::id()).expect("own cwd should resolve");
        assert_eq!(
            cwd.canonicalize().unwrap(),
            std::env::current_dir().unwrap().canonicalize().unwrap()
        );
    }
}

/// First `PATH` entry that contains an executable named `exe`, or `None`.
/// Used to resolve bare command names (the Windows `default_shell` arm and
/// [`resolve_shell`]); on Unix `PATH` lookup is otherwise left to exec.
fn find_on_path(exe: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// Short executable name behind `pid`, for the confirm-on-close dialog
/// ("claude is still running…"). Best-effort: `None` simply degrades the
/// dialog copy to "a program".
#[cfg(target_os = "macos")]
pub fn foreground_process_name(pid: i32) -> Option<String> {
    // proc_name caps at 2*MAXCOMLEN (32 bytes + NUL headroom).
    let mut buf = [0u8; 64];
    let n = unsafe {
        libc::proc_name(pid, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32)
    };
    if n <= 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn foreground_process_name(pid: i32) -> Option<String> {
    let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    let name = comm.trim();
    (!name.is_empty()).then(|| name.to_string())
}

#[cfg(not(unix))]
pub fn foreground_process_name(_pid: i32) -> Option<String> {
    None
}

/// Current working directory of a process, queried from the OS. The git
/// panel uses this to follow `cd` in a tab's shell without any shell
/// integration (no OSC 7 hooks required).
#[cfg(target_os = "macos")]
pub fn process_cwd(pid: u32) -> Option<PathBuf> {
    // Layout-compatible subset of `struct proc_vnodepathinfo` from
    // <sys/proc_info.h>: two `vnode_info_path`s (cwd, then chroot), each a
    // 152-byte `vnode_info` followed by a MAXPATHLEN path buffer. Total size
    // must match the real struct (2352 bytes) or proc_pidinfo rejects it.
    #[repr(C)]
    struct VnodeInfoPath {
        _vnode_info: [u8; 152],
        path: [u8; 1024],
    }
    #[repr(C)]
    struct ProcVnodePathInfo {
        cdir: VnodeInfoPath,
        _rdir: VnodeInfoPath,
    }
    const PROC_PIDVNODEPATHINFO: libc::c_int = 9;

    let mut info: ProcVnodePathInfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<ProcVnodePathInfo>() as libc::c_int;
    let n = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    if n < size {
        return None;
    }
    let path = &info.cdir.path;
    let len = path.iter().position(|&b| b == 0).unwrap_or(path.len());
    if len == 0 {
        return None;
    }
    use std::os::unix::ffi::OsStrExt;
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(&path[..len])))
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn process_cwd(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

/// Windows has no stable public API for another process's cwd (it lives in
/// the PEB) — callers fall back to the file browser's directory.
#[cfg(not(unix))]
pub fn process_cwd(_pid: u32) -> Option<PathBuf> {
    None
}

