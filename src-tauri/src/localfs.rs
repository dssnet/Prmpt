//! Local-filesystem operations backing the optional local file browser.
//!
//! These are plain synchronous `std::fs` calls. The command wrappers in
//! [`crate::commands`] are intentionally **non-`async`** so Tauri runs them on
//! a worker thread — keeping the blocking `read_dir`/`metadata` work off the
//! async runtime (the `sftp_*` commands, by contrast, route through channels).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::error::{AppError, AppResult};
use crate::protocol::{LocalDrive, LocalEntry, LocalListing};

/// List a directory: its canonical path, parent, and dirs-first / then
/// case-insensitive sorted entries. Unreadable entries are skipped rather than
/// failing the whole listing.
pub fn list_dir(path: &str) -> AppResult<LocalListing> {
    let dir = PathBuf::from(path);
    // `dunce::canonicalize` strips Windows' `\\?\` verbatim prefix (which
    // `fs::canonicalize` adds) so breadcrumbs render and paths round-trip to
    // the shell cleanly; it's a no-op alias for `fs::canonicalize` elsewhere.
    let canonical = dunce::canonicalize(&dir).unwrap_or(dir);

    let mut entries: Vec<LocalEntry> = Vec::new();
    for dent in fs::read_dir(&canonical)? {
        let Ok(dent) = dent else { continue };
        let p = dent.path();
        // `symlink_metadata` doesn't follow links, so we can flag symlinks;
        // `metadata` follows them to learn whether the target is a directory.
        let link_meta = dent.metadata().ok();
        let is_symlink = link_meta.as_ref().map(|m| m.file_type().is_symlink()).unwrap_or(false);
        let target_meta = fs::metadata(&p).ok();
        let is_dir = target_meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = target_meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mtime = target_meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        entries.push(LocalEntry {
            name: dent.file_name().to_string_lossy().into_owned(),
            path: p.to_string_lossy().into_owned(),
            is_dir,
            is_symlink,
            size,
            mtime,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    let parent = canonical
        .parent()
        .map(|p| p.to_string_lossy().into_owned());

    Ok(LocalListing {
        path: canonical.to_string_lossy().into_owned(),
        parent,
        entries,
    })
}

/// Enumerate the filesystem roots the user can switch between in the browser.
///
/// - Windows: every attached drive letter (`C:\`, `D:\`, …), probed `A`..=`Z`
///   (avoids pulling in a WinAPI crate just for `GetLogicalDrives`).
/// - macOS: the root `/` plus each mounted volume under `/Volumes`.
/// - Linux: the root `/` plus mount points under `/mnt` and `/media`.
pub fn list_drives() -> Vec<LocalDrive> {
    let mut drives: Vec<LocalDrive> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        for letter in b'A'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            // `is_navigable` skips drive letters that exist but can't be opened
            // (an empty optical/card-reader slot), which would only error on click.
            if is_navigable(Path::new(&root)) {
                drives.push(LocalDrive {
                    name: format!("{}:", letter as char),
                    path: root,
                });
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        drives.push(LocalDrive { name: "/".into(), path: "/".into() });
        let mount_parents: &[&str] = if cfg!(target_os = "macos") {
            &["/Volumes"]
        } else {
            &["/mnt", "/media"]
        };
        for parent in mount_parents {
            let Ok(rd) = fs::read_dir(parent) else { continue };
            for dent in rd.flatten() {
                let name = dent.file_name().to_string_lossy().into_owned();
                let p = dent.path();
                // Skip hidden/synthetic mounts (macOS `.timemachine`,
                // `com.apple.TimeMachine.localsnapshots`, snapshot mounts) and
                // anything we can't actually list — they'd only error on click.
                if name.starts_with('.') || !is_navigable(&p) {
                    continue;
                }
                drives.push(LocalDrive { name, path: p.to_string_lossy().into_owned() });
            }
        }
    }

    drives
}

/// Whether a root can be offered in the drive picker: it must open the same way
/// the browser will (canonicalize, then list), so dead drives and
/// permission-walled snapshot mounts don't appear just to fail when selected.
fn is_navigable(path: &Path) -> bool {
    dunce::canonicalize(path)
        .and_then(|c| fs::read_dir(c).map(drop))
        .is_ok()
}

pub fn mkdir(path: &str) -> AppResult<()> {
    fs::create_dir(path)?;
    Ok(())
}

pub fn rename(from: &str, to: &str) -> AppResult<()> {
    fs::rename(from, to)?;
    Ok(())
}

pub fn remove(path: &str, is_dir: bool) -> AppResult<()> {
    if is_dir {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

/// Open `path` in the OS file manager with the item selected.
pub fn reveal(path: &str) -> AppResult<()> {
    let p = Path::new(path);
    #[cfg(target_os = "macos")]
    {
        run("open", &["-R".as_ref(), p.as_os_str()])
    }
    #[cfg(target_os = "windows")]
    {
        run("explorer", &[format!("/select,{path}").as_ref()])
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // No portable "select the file" on Linux; open its containing folder.
        let dir = p.parent().unwrap_or(p);
        run("xdg-open", &[dir.as_os_str()])
    }
}

/// Open `path` with its default application.
pub fn open(path: &str) -> AppResult<()> {
    let p = Path::new(path);
    #[cfg(target_os = "macos")]
    {
        run("open", &[p.as_os_str()])
    }
    #[cfg(target_os = "windows")]
    {
        // `start` is a cmd builtin; the empty "" is the window-title arg so a
        // quoted path isn't mistaken for the title.
        run("cmd", &["/C".as_ref(), "start".as_ref(), "".as_ref(), p.as_os_str()])
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        run("xdg-open", &[p.as_os_str()])
    }
}

pub fn home() -> AppResult<String> {
    crate::platform::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::Other("could not resolve home directory".into()))
}

#[allow(dead_code)]
fn run(program: &str, args: &[&std::ffi::OsStr]) -> AppResult<()> {
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map_err(AppError::Io)?;
    Ok(())
}
