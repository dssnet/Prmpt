use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

use crate::error::{AppError, AppResult};
use crate::paths;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Config {
    // f64 (not f32): TOML serialization of f32 values like 1.2 writes the
    // nearest-f32 noise (1.2000000476837158) into the user-visible file.
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
    pub shell: Option<String>,
    pub login_shell: bool,
    pub scrollback_lines: usize,
    pub theme: Theme,
    pub ui: UiPrefs,
}

/// The terminal-core subset of `Config`, editable from the settings pane.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TerminalPrefs {
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
    pub shell: Option<String>,
    pub login_shell: bool,
    pub scrollback_lines: usize,
}

/// UI behavior preferences (settings pane / file-browser menus). Window-layout
/// state (panel visibility, widths, ratios) deliberately stays in the
/// webview's localStorage — it's per-machine ephemera, not configuration.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct UiPrefs {
    /// Toast popups when a file operation finishes on a background tab.
    pub toast_notifications: bool,
    /// Play a chime when a program rings the terminal bell or sends an OSC
    /// notification (e.g. Claude Code finishing a task).
    pub notification_sounds: bool,
    /// Ask before a close would kill a running foreground program (tab or
    /// window) or drop an open SSH connection (window close only).
    pub confirm_close_running: bool,
    /// Show dot-prefixed entries in the file browsers.
    pub show_hidden_files: bool,
    /// Show the size column in the file browsers.
    pub show_size: bool,
    /// Show the changed (modified) date column in the file browsers.
    pub show_changed_date: bool,
    /// Show the created date column in the file browsers (local only — the
    /// SFTP protocol doesn't report creation time).
    pub show_created_date: bool,
}

impl Default for UiPrefs {
    fn default() -> Self {
        Self {
            toast_notifications: true,
            notification_sounds: true,
            confirm_close_running: true,
            show_hidden_files: false,
            show_size: true,
            show_changed_date: false,
            show_created_date: false,
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
            // Just the bundled Nerd Font: it's shipped with the app and
            // preloaded in the webview, so it always resolves. Glyphs it
            // lacks fall through to the engine's system font fallback; users
            // can append explicit fallbacks in Settings → Terminal.
            font_family: "\"Noto Nerd Font Mono\"".into(),
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
