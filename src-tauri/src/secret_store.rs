//! Rust-owned secret storage backed by iota_stronghold.
//!
//! Replaces the JS-side `@tauri-apps/plugin-stronghold` for actual
//! secret operations. The plugin's `initialize` command unconditionally
//! re-runs iota's scrypt-heavy snapshot decrypt (four ~128 MB V buffers
//! per call) on every JS-side `Stronghold.load()`, so each window that
//! mounted triggered the same multi-hundred-MB startup spike again.
//!
//! Owning the Stronghold instance on the Rust side means we load the
//! snapshot at most once per process — every window's
//! `secret_get`/`secret_set`/`secret_remove` command hits the same
//! cached state. Loading is lazy: first secret access triggers the
//! one-time decrypt; if the user never opens an SSH host, scrypt
//! never runs.
//!
//! The on-disk snapshot format is unchanged (same path, same client
//! name, same 32-byte boot password from the platform keychain), so
//! existing data created by the JS plugin keeps working.

use iota_stronghold::{KeyProvider, SnapshotPath, Stronghold};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};
use crate::stronghold::prepare_unlock_refresh;

/// Matches the `CLIENT_NAME` constant in the old JS-side `secrets.ts`
/// so we keep reading the same client out of pre-existing snapshots.
const CLIENT_NAME: &[u8] = b"prmpt";

pub struct SecretStore {
    inner: Mutex<Option<Loaded>>,
}

struct Loaded {
    stronghold: Stronghold,
    path: SnapshotPath,
    keyprovider: KeyProvider,
}

impl SecretStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    async fn ensure_loaded<'a>(
        &'a self,
    ) -> AppResult<tokio::sync::MutexGuard<'a, Option<Loaded>>> {
        let mut guard = self.inner.lock().await;
        if guard.is_some() {
            return Ok(guard);
        }

        // Use the refresh variant so a user who declined the boot-time
        // keychain prompt gets a fresh chance to approve when they open
        // an SSH host, rather than staying locked out for the process
        // lifetime. A cached success short-circuits — no extra prompt.
        let unlock = prepare_unlock_refresh()?;
        let password_bytes = hex::decode(&unlock.password)
            .map_err(|e| AppError::Crypto(format!("decode boot password: {e}")))?;
        let path = SnapshotPath::from_path(&unlock.snapshot_path);
        let keyprovider = KeyProvider::try_from(Zeroizing::new(password_bytes))
            .map_err(|e| AppError::Crypto(format!("keyprovider: {e}")))?;

        let stronghold = Stronghold::default();
        if path.exists() {
            // This is the call that runs scrypt. Once per process.
            stronghold
                .load_snapshot(&keyprovider, &path)
                .map_err(|e| AppError::Crypto(format!("load_snapshot: {e}")))?;
        }

        // Make sure our client exists in-memory; create + commit if it doesn't.
        if stronghold.load_client(CLIENT_NAME).is_err() {
            stronghold
                .create_client(CLIENT_NAME)
                .map_err(|e| AppError::Crypto(format!("create_client: {e}")))?;
            stronghold
                .commit_with_keyprovider(&path, &keyprovider)
                .map_err(|e| AppError::Crypto(format!("initial commit: {e}")))?;
        }

        *guard = Some(Loaded {
            stronghold,
            path,
            keyprovider,
        });
        Ok(guard)
    }

    pub async fn get(&self, key: &str) -> AppResult<Option<Vec<u8>>> {
        let guard = self.ensure_loaded().await?;
        let loaded = guard.as_ref().expect("ensure_loaded set inner");
        let client = loaded
            .stronghold
            .get_client(CLIENT_NAME)
            .map_err(|e| AppError::Crypto(format!("get_client: {e}")))?;
        client
            .store()
            .get(key.as_bytes())
            .map_err(|e| AppError::Crypto(format!("store.get: {e}")))
    }

    pub async fn set(&self, key: &str, value: Vec<u8>) -> AppResult<()> {
        let guard = self.ensure_loaded().await?;
        let loaded = guard.as_ref().expect("ensure_loaded set inner");
        let client = loaded
            .stronghold
            .get_client(CLIENT_NAME)
            .map_err(|e| AppError::Crypto(format!("get_client: {e}")))?;
        client
            .store()
            .insert(key.as_bytes().to_vec(), value, None)
            .map_err(|e| AppError::Crypto(format!("store.insert: {e}")))?;
        loaded
            .stronghold
            .commit_with_keyprovider(&loaded.path, &loaded.keyprovider)
            .map_err(|e| AppError::Crypto(format!("commit: {e}")))?;
        Ok(())
    }

    pub async fn remove(&self, key: &str) -> AppResult<()> {
        let guard = self.ensure_loaded().await?;
        let loaded = guard.as_ref().expect("ensure_loaded set inner");
        let client = loaded
            .stronghold
            .get_client(CLIENT_NAME)
            .map_err(|e| AppError::Crypto(format!("get_client: {e}")))?;
        client
            .store()
            .delete(key.as_bytes())
            .map_err(|e| AppError::Crypto(format!("store.delete: {e}")))?;
        loaded
            .stronghold
            .commit_with_keyprovider(&loaded.path, &loaded.keyprovider)
            .map_err(|e| AppError::Crypto(format!("commit: {e}")))?;
        Ok(())
    }
}
