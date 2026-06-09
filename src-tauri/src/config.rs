use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

use crate::error::{AppError, AppResult};
use crate::paths;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Config {
    pub font_family: String,
    pub font_size: f32,
    pub line_height: f32,
    pub shell: Option<String>,
    pub login_shell: bool,
    pub scrollback_lines: usize,
    pub theme: Theme,
    pub ui: UiPrefs,
}

/// UI behavior preferences (settings pane / file-browser menus). Window-layout
/// state (panel visibility, widths, ratios) deliberately stays in the
/// webview's localStorage — it's per-machine ephemera, not configuration.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct UiPrefs {
    /// Toast popups when a file operation finishes on a background tab.
    pub toast_notifications: bool,
    /// Show dot-prefixed entries in the file browsers.
    pub show_hidden_files: bool,
}

impl Default for UiPrefs {
    fn default() -> Self {
        Self {
            toast_notifications: true,
            show_hidden_files: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Theme {
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub palette: [String; 16],
}

impl Default for Config {
    fn default() -> Self {
        Self {
            font_family: "\"Noto Nerd Font Mono\", Menlo, ui-monospace, monospace".into(),
            font_size: 13.0,
            line_height: 1.2,
            shell: None,
            login_shell: true,
            scrollback_lines: 10_000,
            theme: Theme::default(),
            ui: UiPrefs::default(),
        }
    }
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            background: "#1e1e2e".into(),
            foreground: "#cdd6f4".into(),
            cursor: "#f5e0dc".into(),
            palette: [
                "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5",
                "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7",
                "#94e2d5", "#a6adc8",
            ]
            .map(String::from),
        }
    }
}

fn config_path() -> AppResult<PathBuf> {
    Ok(paths::ensure_app_data_dir()?.join("config.toml"))
}

impl Config {
    pub fn load_or_default() -> Self {
        match Self::load() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[config] load failed: {e}; using defaults");
                Self::default()
            }
        }
    }

    pub fn load() -> AppResult<Self> {
        let path = config_path()?;
        if !path.exists() {
            let parent = path
                .parent()
                .ok_or_else(|| AppError::Config("config path has no parent".into()))?;
            fs::create_dir_all(parent)?;
            let default = Self::default();
            let s = toml::to_string_pretty(&default)
                .map_err(|e| AppError::Config(format!("serialize default: {e}")))?;
            fs::write(&path, s)?;
            return Ok(default);
        }
        let s = fs::read_to_string(&path)?;
        toml::from_str(&s).map_err(|e| AppError::Config(format!("parse {}: {e}", path.display())))
    }

    pub fn save(&self) -> AppResult<()> {
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let s = toml::to_string_pretty(self)
            .map_err(|e| AppError::Config(format!("serialize: {e}")))?;
        fs::write(&path, s)?;
        Ok(())
    }
}
