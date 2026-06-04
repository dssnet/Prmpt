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
#[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
pub fn sanitize_child_env(cmd: &mut portable_pty::CommandBuilder) {
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
