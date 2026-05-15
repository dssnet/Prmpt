use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("tab {0} not found")]
    UnknownTab(u64),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("pty error: {0}")]
    Pty(String),
    #[error("ghostty error: {0:?}")]
    Ghostty(libghostty_vt::Error),
    #[error("config error: {0}")]
    Config(String),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("ssh error: {0}")]
    Ssh(String),
    #[error("{0}")]
    Other(String),
}

impl From<libghostty_vt::Error> for AppError {
    fn from(e: libghostty_vt::Error) -> Self {
        AppError::Ghostty(e)
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
