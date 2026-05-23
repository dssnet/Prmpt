//! Cross-platform secure storage for the 32-byte Stronghold boot key.
//!
//! On each platform we use the OS-native secret store:
//! - macOS / iOS: Keychain Services (`security-framework`)
//! - Windows: Credential Manager (`windows-rs` `CredWriteW`/`CredReadW`)
//! - Linux: Secret Service over D-Bus (`secret-service` crate)
//! - Android: not yet implemented; reports `Unavailable` so callers fall
//!   back to the legacy file in the per-app sandbox.
//!
//! Service / account naming is uniform across platforms so the entry is
//! discoverable from the system tools (`security find-generic-password -s
//! de.dss-net.prmpt`, `cmdkey /list`, `secret-tool search ...`).
//!
//! The boot key never leaves the process as anything but a `[u8; 32]`.
//! Callers stack-allocate, copy in, and zeroize after use.

use std::fmt;

pub const SERVICE: &str = "de.dss-net.prmpt";
pub const ACCOUNT: &str = "stronghold-boot-key";
// Used by Windows (`Comment` field) and Linux (Secret Service label). On
// Apple platforms `set_generic_password` doesn't take a label; on Android
// it's stubbed. Allow dead_code so the platform-conditional usage doesn't
// trip warnings on the platforms that don't read it.
#[allow(dead_code)]
pub const LABEL: &str = "Prmpt Stronghold boot key";

/// Errors a backend can produce.
///
/// `Unavailable` means the platform secret store isn't present on this
/// system (no D-Bus session, Android stub, exotic OS). The caller should
/// fall back to the legacy file path **silently** — that's the expected
/// path for headless Linux / WSL / Android.
///
/// `Backend` means the store was present but the operation failed
/// (permissions denied, keychain locked, corrupted entry). The caller
/// should log loudly **and** fall back, so the user is never locked out
/// of secrets they already have.
#[derive(Debug)]
pub enum SecureStoreError {
    // Constructed by the Linux backend (no D-Bus session) and the
    // Android stub. On macOS / iOS / Windows the backend is always
    // present, so this variant is unreachable there — `allow(dead_code)`
    // silences the per-target warning.
    #[allow(dead_code)]
    Unavailable(String),
    Backend(String),
}

impl fmt::Display for SecureStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(s) => write!(f, "secure store unavailable: {s}"),
            Self::Backend(s) => write!(f, "secure store backend error: {s}"),
        }
    }
}

impl std::error::Error for SecureStoreError {}

/// Trait so `load_or_create_boot_password` can be unit-tested with a
/// mock in place of the real platform backend.
pub trait SecureStore {
    fn load(&self) -> Result<Option<[u8; 32]>, SecureStoreError>;
    fn store(&self, key: &[u8; 32]) -> Result<(), SecureStoreError>;
    #[allow(dead_code)]
    fn delete(&self) -> Result<(), SecureStoreError>;
}

/// Platform default: dispatches to the cfg-selected backend module.
pub struct PlatformStore;

impl SecureStore for PlatformStore {
    fn load(&self) -> Result<Option<[u8; 32]>, SecureStoreError> {
        backend::load()
    }
    fn store(&self, key: &[u8; 32]) -> Result<(), SecureStoreError> {
        backend::store(key)
    }
    fn delete(&self) -> Result<(), SecureStoreError> {
        backend::delete()
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
#[path = "apple.rs"]
mod backend;

#[cfg(target_os = "windows")]
#[path = "windows.rs"]
mod backend;

#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod backend;

#[cfg(target_os = "android")]
#[path = "android.rs"]
mod backend;

#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux",
    target_os = "android",
)))]
mod backend {
    use super::SecureStoreError;
    pub fn load() -> Result<Option<[u8; 32]>, SecureStoreError> {
        Err(SecureStoreError::Unavailable("unsupported OS".into()))
    }
    pub fn store(_: &[u8; 32]) -> Result<(), SecureStoreError> {
        Err(SecureStoreError::Unavailable("unsupported OS".into()))
    }
    pub fn delete() -> Result<(), SecureStoreError> {
        Err(SecureStoreError::Unavailable("unsupported OS".into()))
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use std::sync::Mutex;

    /// In-memory `SecureStore` for unit tests. Optionally simulates a
    /// backend that's unavailable (so the file-fallback branches can be
    /// exercised).
    pub struct MockStore {
        inner: Mutex<MockState>,
    }

    struct MockState {
        key: Option<[u8; 32]>,
        load_err: Option<SecureStoreError>,
        store_err: Option<SecureStoreError>,
    }

    impl MockStore {
        pub fn empty() -> Self {
            Self {
                inner: Mutex::new(MockState {
                    key: None,
                    load_err: None,
                    store_err: None,
                }),
            }
        }
        pub fn with_key(k: [u8; 32]) -> Self {
            let s = Self::empty();
            s.inner.lock().unwrap().key = Some(k);
            s
        }
        pub fn unavailable() -> Self {
            let s = Self::empty();
            let mut st = s.inner.lock().unwrap();
            st.load_err = Some(SecureStoreError::Unavailable("mock".into()));
            st.store_err = Some(SecureStoreError::Unavailable("mock".into()));
            drop(st);
            s
        }
        /// Backend present but operations fail with `Backend(_)` — models
        /// the user cancelling the macOS keychain prompt or entering the
        /// wrong account password. `load()` errors; if the caller would
        /// later try to `store()` a fresh key, that fails too (a real
        /// denied keychain rejects writes for the same reason it rejects
        /// reads). `stored_key` returns whatever was previously set so
        /// tests can assert the keychain wasn't clobbered.
        pub fn denied() -> Self {
            let s = Self::empty();
            let mut st = s.inner.lock().unwrap();
            st.load_err = Some(SecureStoreError::Backend("mock denied".into()));
            st.store_err = Some(SecureStoreError::Backend("mock denied".into()));
            drop(st);
            s
        }
        pub fn stored_key(&self) -> Option<[u8; 32]> {
            self.inner.lock().unwrap().key
        }
    }

    impl SecureStore for MockStore {
        fn load(&self) -> Result<Option<[u8; 32]>, SecureStoreError> {
            let st = self.inner.lock().unwrap();
            if let Some(e) = &st.load_err {
                return Err(match e {
                    SecureStoreError::Unavailable(s) => {
                        SecureStoreError::Unavailable(s.clone())
                    }
                    SecureStoreError::Backend(s) => {
                        SecureStoreError::Backend(s.clone())
                    }
                });
            }
            Ok(st.key)
        }
        fn store(&self, key: &[u8; 32]) -> Result<(), SecureStoreError> {
            let mut st = self.inner.lock().unwrap();
            if let Some(e) = &st.store_err {
                return Err(match e {
                    SecureStoreError::Unavailable(s) => {
                        SecureStoreError::Unavailable(s.clone())
                    }
                    SecureStoreError::Backend(s) => {
                        SecureStoreError::Backend(s.clone())
                    }
                });
            }
            st.key = Some(*key);
            Ok(())
        }
        fn delete(&self) -> Result<(), SecureStoreError> {
            self.inner.lock().unwrap().key = None;
            Ok(())
        }
    }
}
