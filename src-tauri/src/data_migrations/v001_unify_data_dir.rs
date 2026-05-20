//! v1: move config.toml, stronghold.key, prmpt.stronghold (from
//! `ProjectDirs::config_dir()`) and prmpt.db (from the old bundle-id
//! dir Tauri's `app_config_dir()` used to resolve to) into the new
//! unified `Prmpt` folder owned by `crate::paths`.

use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::error::{AppError, AppResult};

use super::DataMigration;

pub const MIGRATION: DataMigration = DataMigration {
    version: 1,
    description: "unify on-disk data into a single Prmpt folder",
    run,
};

const MIGRATED_FILES: &[&str] = &[
    "config.toml",
    "prmpt.db",
    "stronghold.key",
    "prmpt.stronghold",
];

fn run(new_dir: &Path) -> AppResult<()> {
    // Floor for `remove_empty_dirs_up_to`: never try to delete the
    // platform's base config dir itself (`~/.config`, `%APPDATA%`, …).
    let floor = directories::BaseDirs::new().map(|b| b.config_dir().to_path_buf());

    let mut sources: Vec<PathBuf> = Vec::new();
    if let Some(d) = directories::ProjectDirs::from("de", "dss-net", "prmpt") {
        sources.push(d.config_dir().to_path_buf());
    }
    if let Some(b) = directories::BaseDirs::new() {
        sources.push(b.config_dir().join("de.dss-net.prmpt"));
    }
    for src in sources {
        if !src.exists() || src == *new_dir {
            continue;
        }
        move_known_files(&src, new_dir)?;
        remove_empty_dirs_up_to(&src, floor.as_deref());
    }
    Ok(())
}

fn move_known_files(src: &Path, dst: &Path) -> AppResult<()> {
    for name in MIGRATED_FILES {
        let from = src.join(name);
        let to = dst.join(name);
        if from.exists() && !to.exists() {
            eprintln!("[data] move {} → {}", from.display(), to.display());
            // `rename` fails across filesystems; copy+remove as fallback.
            if fs::rename(&from, &to).is_err() {
                fs::copy(&from, &to)
                    .map_err(|e| AppError::Config(format!("copy {}: {e}", from.display())))?;
                let _ = fs::remove_file(&from);
            }
        }
    }
    Ok(())
}

/// Walk up from `start`, deleting each directory if (and only if) it is
/// empty. Stops at the first non-empty directory, the first error, or
/// the platform's base config dir (`floor`). `fs::remove_dir` itself
/// only succeeds on empty directories, so this never touches anything
/// that holds another app's data.
fn remove_empty_dirs_up_to(start: &Path, floor: Option<&Path>) {
    let mut cur: PathBuf = start.to_path_buf();
    loop {
        if floor.is_some_and(|f| cur == *f) {
            break;
        }
        if fs::remove_dir(&cur).is_err() {
            break;
        }
        eprintln!("[data] removed empty legacy dir {}", cur.display());
        match cur.parent() {
            Some(p) => cur = p.to_path_buf(),
            None => break,
        }
    }
}
