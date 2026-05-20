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

use crate::error::{AppError, AppResult};
use crate::paths::ensure_app_data_dir;

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
