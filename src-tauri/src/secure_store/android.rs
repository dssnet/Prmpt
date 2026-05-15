//! Android backend — stub.
//!
//! The Android Tauri project hasn't been generated yet
//! (`src-tauri/gen/android/` does not exist) so we can't compile-test a
//! JNI bridge or a Kotlin Tauri 2 plugin. Until that scaffold lands,
//! this module reports `Unavailable` and the caller falls back to the
//! legacy file in `/data/data/de.dss-net.prmpt/files/`. App-private
//! storage on Android is already sandboxed per-app, so the file is
//! unreadable from other apps without root.
//!
//! TODO: once `tauri android init` has been run, replace this with a
//! Tauri 2 mobile plugin that wraps `EncryptedSharedPreferences`
//! (Jetpack Security `MasterKey` with AES256_GCM key scheme). The Rust
//! side can invoke into the plugin via the `tauri::plugin::PluginApi`
//! / `run_mobile_plugin` shim.

use super::SecureStoreError;

pub fn load() -> Result<Option<[u8; 32]>, SecureStoreError> {
    Err(SecureStoreError::Unavailable(
        "android backend not yet implemented".into(),
    ))
}

pub fn store(_: &[u8; 32]) -> Result<(), SecureStoreError> {
    Err(SecureStoreError::Unavailable(
        "android backend not yet implemented".into(),
    ))
}

pub fn delete() -> Result<(), SecureStoreError> {
    Err(SecureStoreError::Unavailable(
        "android backend not yet implemented".into(),
    ))
}
