//! Versioned data-directory migrations. Run once at startup, BEFORE
//! anything else reads or writes config.toml, stronghold files, or the
//! SQLite DB. Each migration is idempotent and runs at most once;
//! progress is tracked in `<app_data>/data_version` (plain text).
//!
//! Distinct from tauri-plugin-sql migrations, which operate inside the
//! database. Use this for file moves, renames, format changes, …
//!
//! To add a migration: create `vNNN_short_name.rs` next to this file
//! exposing `pub const MIGRATION: DataMigration = …;` and add a line
//! to the `MIGRATIONS` slice below.

use std::{fs, path::Path};

use tauri::{AppHandle, Manager, Runtime};

use crate::error::{AppError, AppResult};
use crate::paths::{app_data_dir, ensure_app_data_dir};

mod v001_unify_data_dir;

pub struct DataMigration {
    pub version: u32,
    pub description: &'static str,
    pub run: fn(new_dir: &Path) -> AppResult<()>,
}

const VERSION_FILE: &str = "data_version";

const MIGRATIONS: &[&DataMigration] = &[&v001_unify_data_dir::MIGRATION];

pub fn run() -> AppResult<()> {
    let new_dir = ensure_app_data_dir()?;
    let current = read_version(&new_dir);
    for m in MIGRATIONS {
        if m.version > current {
            eprintln!("[data] applying v{} {}", m.version, m.description);
            (m.run)(&new_dir)?;
            write_version(&new_dir, m.version)?;
        }
    }
    Ok(())
}

fn read_version(dir: &Path) -> u32 {
    fs::read_to_string(dir.join(VERSION_FILE))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

fn write_version(dir: &Path, v: u32) -> AppResult<()> {
    fs::write(dir.join(VERSION_FILE), v.to_string())
        .map_err(|e| AppError::Config(format!("write data_version: {e}")))
}

/// Remove the bundle-id config directory (e.g.
/// `~/.config/de.dss-net.prmpt` on Linux) if it is empty.
///
/// `tauri-plugin-sql` calls `app.path().app_config_dir()` and
/// `create_dir_all` on it inside its own plugin setup — regardless of
/// whether the connection URL is absolute and points elsewhere. We
/// resolve the SQLite path via [`crate::paths`] to a unified `Prmpt/`
/// directory, so this bundle-id folder is always unused; the plugin
/// just leaves an empty husk behind on every startup.
///
/// Must run AFTER plugin setups (i.e. from the Tauri builder's own
/// `.setup` hook). The versioned migration framework above runs before
/// any plugin and so can't see the folder that's about to be created.
pub fn cleanup_unused_app_config_dir<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    // Defensive: never delete the dir we actually use, even if a future
    // refactor accidentally points both at the same place.
    if app_data_dir().is_ok_and(|ours| ours == dir) {
        return;
    }
    match fs::remove_dir(&dir) {
        Ok(()) => eprintln!("[data] removed unused {}", dir.display()),
        // NotFound: already gone (steady state once cleanup has run).
        // DirectoryNotEmpty: user dropped something in there — leave it.
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) => {}
        Err(e) => eprintln!("[data] could not remove unused {}: {e}", dir.display()),
    }
}
