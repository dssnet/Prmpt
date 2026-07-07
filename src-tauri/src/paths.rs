//! Single source of truth for the app's on-disk data directory.
//! All persistent files (config.toml, prmpt.db, stronghold.key,
//! prmpt.stronghold) live here on every OS.

use std::path::PathBuf;

use directories::BaseDirs;

use crate::error::{AppError, AppResult};

pub const APP_DIR_NAME: &str = "Prmpt";

pub fn app_data_dir() -> AppResult<PathBuf> {
    // Escape hatch for running a second, isolated instance side by side
    // (e.g. testing WebDAV sync between two "devices" on one machine):
    //   PRMPT_DATA_DIR=/tmp/prmpt-b ./prmpt
    // Everything that persists (config.toml, prmpt.db, prmpt.stronghold,
    // data_version) follows, because every consumer resolves through here.
    // The Stronghold boot key is the one shared bit — it lives in the OS
    // keyring under a fixed service name — which is exactly right: each
    // instance decrypts its own snapshot file with the same key.
    if let Ok(dir) = std::env::var("PRMPT_DATA_DIR") {
        let dir = dir.trim();
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    let base = BaseDirs::new()
        .ok_or_else(|| AppError::Config("cannot resolve base dirs".into()))?;
    Ok(base.config_dir().join(APP_DIR_NAME))
}

pub fn ensure_app_data_dir() -> AppResult<PathBuf> {
    let dir = app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn db_path() -> AppResult<PathBuf> {
    Ok(app_data_dir()?.join("prmpt.db"))
}

/// Connection URL handed to `tauri-plugin-sql`. Windows paths contain
/// backslashes that break the URL parser, so normalize to forward
/// slashes — SQLx accepts `sqlite:<abs-path-with-forward-slashes>` on
/// every OS.
pub fn db_url() -> AppResult<String> {
    let p = db_path()?;
    Ok(format!("sqlite:{}", p.to_string_lossy().replace('\\', "/")))
}
