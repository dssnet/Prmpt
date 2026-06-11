//! Single source of truth for the app's on-disk data directory.
//! All persistent files (config.toml, prmpt.db, stronghold.key,
//! prmpt.stronghold) live here on every OS.

use std::path::PathBuf;

use directories::BaseDirs;

use crate::error::{AppError, AppResult};

pub const APP_DIR_NAME: &str = "Prmpt";

pub fn app_data_dir() -> AppResult<PathBuf> {
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
