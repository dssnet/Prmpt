//! Boot password + snapshot quarantine for the Stronghold snapshot.
//!
//! The actual iota_stronghold instance lives in [`crate::secret_store`]
//! — this module only manages the on-disk material around it:
//!
//! 1. Keep a 32-byte random "boot password" in the platform secret store
//!    ([`crate::secure_store`]). On systems where that backend is
//!    unavailable (no Secret Service on Linux, Android until its plugin
//!    is wired up), we fall back to `stronghold.key` on disk — same
//!    security model as a passphrase-less SSH key.
//! 2. Detect when a stale snapshot exists alongside a freshly-generated
//!    boot password (which would be undecryptable with the new key) and
//!    move it aside on startup — saving the user from a multi-second
//!    scrypt attempt that's doomed to fail.
//! 3. Expose [`StrongholdUnlock`] (path + hex password + quarantine
//!    flag) to the frontend via `get_stronghold_unlock`, and to
//!    [`crate::secret_store`] which uses it to load the snapshot the
//!    first time a secret is accessed.

use std::{
    io::Write,
    path::{Path, PathBuf},
};

use rand::RngCore;
use serde::Serialize;

use crate::{
    error::{AppError, AppResult},
    paths,
    secure_store::{PlatformStore, SecureStore, SecureStoreError},
};

/// Path + password the secret store (and the frontend, for the
/// quarantine flag) need to decrypt the snapshot.
#[derive(Serialize, Clone, Debug)]
pub struct StrongholdUnlock {
    pub snapshot_path: String,
    pub password: String,
    /// `true` when this boot detected a stale snapshot and moved it
    /// aside. The frontend should mark every previously-saved
    /// host/key as broken (needs re-entry).
    pub was_quarantined: bool,
}

/// Prepare the on-disk state needed to decrypt the snapshot: ensure a
/// boot password exists and quarantine the snapshot if the password is
/// fresh. Called once eagerly at startup, then again lazily by the
/// secret store on first secret access.
pub fn prepare_unlock() -> AppResult<StrongholdUnlock> {
    let (password_bytes, password_was_fresh) = load_or_create_boot_password()?;
    let snapshot = snapshot_path()?;
    let mut quarantined = false;

    // Fresh boot password + existing snapshot ⇒ snapshot was encrypted
    // with some other key and can't be decrypted with what we have.
    // Move it aside before the JS plugin wastes seconds of scrypt
    // trying to open it.
    if password_was_fresh && snapshot.exists() {
        let aside = quarantine_path(&snapshot);
        eprintln!(
            "[stronghold] fresh boot password but snapshot exists; \
             quarantining {} → {} (old secrets are unrecoverable)",
            snapshot.display(),
            aside.display(),
        );
        std::fs::rename(&snapshot, &aside).map_err(|e| {
            AppError::Crypto(format!(
                "rename orphan snapshot to {}: {e}",
                aside.display()
            ))
        })?;
        quarantined = true;
    }

    Ok(StrongholdUnlock {
        snapshot_path: snapshot.display().to_string(),
        password: hex::encode(&password_bytes),
        was_quarantined: quarantined,
    })
}

/// `(password_bytes, freshly_generated)`. `freshly_generated` is `true`
/// **only** when neither the platform secret store nor the legacy file
/// held a key — i.e. when the snapshot (if any) can't possibly be
/// decrypted with what we have. Migrating an existing key from the file
/// into the secret store does *not* count as freshly-generated: the key
/// itself is unchanged.
fn load_or_create_boot_password() -> AppResult<(Vec<u8>, bool)> {
    let path = boot_password_path()?;
    let store = PlatformStore;
    load_or_create_boot_password_with(&store, &path)
}

fn load_or_create_boot_password_with<S: SecureStore>(
    store: &S,
    file: &Path,
) -> AppResult<(Vec<u8>, bool)> {
    // 1. Platform secret store first.
    match store.load() {
        Ok(Some(k)) => {
            if file.exists() {
                match std::fs::remove_file(file) {
                    Ok(()) => eprintln!(
                        "[secure_store] cleaned up stale legacy boot-key file {}",
                        file.display()
                    ),
                    Err(e) => eprintln!(
                        "[secure_store] keychain holds boot key but legacy {} could not be deleted: {e}",
                        file.display()
                    ),
                }
            }
            return Ok((k.to_vec(), false));
        }
        Ok(None) => { /* fall through to step 2 */ }
        Err(SecureStoreError::Unavailable(reason)) => {
            eprintln!(
                "[secure_store] backend unavailable ({reason}); using legacy file"
            );
        }
        Err(SecureStoreError::Backend(reason)) => {
            eprintln!(
                "[secure_store] backend error on load ({reason}); falling back to legacy file"
            );
        }
    }

    // 2. Legacy file? If so, try to migrate it into the secret store.
    if file.exists() {
        let bytes = std::fs::read(file)
            .map_err(|e| AppError::Crypto(format!("read {}: {e}", file.display())))?;
        if bytes.len() != 32 {
            return Err(AppError::Crypto(format!(
                "boot password at {} has wrong length {} (want 32)",
                file.display(),
                bytes.len()
            )));
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        match store.store(&arr) {
            Ok(()) => match std::fs::remove_file(file) {
                Ok(()) => eprintln!(
                    "[secure_store] migrated boot key from {} to platform keychain",
                    file.display()
                ),
                Err(e) => eprintln!(
                    "[secure_store] migrated boot key to keychain but failed to delete {}: {e}",
                    file.display()
                ),
            },
            Err(e) => eprintln!(
                "[secure_store] could not migrate boot key from file to keychain ({e}); leaving file in place"
            ),
        }
        // Key itself is unchanged; snapshot still decrypts. Not fresh.
        return Ok((bytes, false));
    }

    // 3. Generate fresh.
    let mut k = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut k);

    match store.store(&k) {
        Ok(()) => {
            eprintln!(
                "[secure_store] generated fresh boot key, stored in platform keychain"
            );
        }
        Err(e) => {
            eprintln!(
                "[secure_store] could not store fresh boot key in keychain ({e}); writing to {}",
                file.display()
            );
            write_boot_password_file(file, &k)?;
        }
    }
    Ok((k.to_vec(), true))
}

fn write_boot_password_file(path: &Path, key: &[u8; 32]) -> AppResult<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(path)
        .map_err(|e| AppError::Crypto(format!("create {}: {e}", path.display())))?;
    f.write_all(key)
        .map_err(|e| AppError::Crypto(format!("write {}: {e}", path.display())))?;
    f.sync_all()
        .map_err(|e| AppError::Crypto(format!("fsync {}: {e}", path.display())))?;
    Ok(())
}

fn data_dir() -> AppResult<PathBuf> {
    paths::ensure_app_data_dir()
}

fn boot_password_path() -> AppResult<PathBuf> {
    Ok(data_dir()?.join("stronghold.key"))
}

fn snapshot_path() -> AppResult<PathBuf> {
    Ok(data_dir()?.join("prmpt.stronghold"))
}

fn quarantine_path(snapshot: &std::path::Path) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut name = snapshot
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_else(|| std::ffi::OsString::from("prmpt.stronghold"));
    name.push(".broken-");
    name.push(stamp.to_string());
    snapshot.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_store::testing::MockStore;

    fn tmpfile(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        let pid = std::process::id();
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("prmpt-test-{pid}-{ts}-{name}"));
        // Ensure clean state.
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn fresh_install_generates_and_stores_in_keychain() {
        let path = tmpfile("fresh");
        let store = MockStore::empty();

        let (k, fresh) = load_or_create_boot_password_with(&store, &path).unwrap();

        assert!(fresh, "first ever boot must be flagged fresh");
        assert_eq!(k.len(), 32);
        let stored = store.stored_key().expect("keychain populated");
        assert_eq!(stored.as_slice(), k.as_slice());
        assert!(!path.exists(), "no file should be created when keychain works");
    }

    #[test]
    fn legacy_file_migrates_to_keychain_and_is_deleted() {
        let path = tmpfile("legacy");
        let mut legacy_key = [0u8; 32];
        for (i, b) in legacy_key.iter_mut().enumerate() {
            *b = i as u8;
        }
        std::fs::write(&path, legacy_key).unwrap();

        let store = MockStore::empty();
        let (k, fresh) = load_or_create_boot_password_with(&store, &path).unwrap();

        assert!(!fresh, "migration must NOT flag as fresh");
        assert_eq!(k.as_slice(), legacy_key.as_slice());
        assert_eq!(store.stored_key().unwrap().as_slice(), legacy_key.as_slice());
        assert!(!path.exists(), "legacy file must be removed after migration");
    }

    #[test]
    fn keychain_already_populated_clears_stale_file() {
        let path = tmpfile("populated");
        // Leftover legacy file from before keychain migration.
        std::fs::write(&path, [0xCCu8; 32]).unwrap();

        let mut keychain_key = [0u8; 32];
        for (i, b) in keychain_key.iter_mut().enumerate() {
            *b = (i as u8).wrapping_add(7);
        }
        let store = MockStore::with_key(keychain_key);

        let (k, fresh) = load_or_create_boot_password_with(&store, &path).unwrap();

        assert!(!fresh);
        assert_eq!(k.as_slice(), keychain_key.as_slice());
        assert!(!path.exists(), "stale legacy file should be cleaned up");
    }

    #[test]
    fn backend_unavailable_falls_back_to_file_and_stays_unfresh_on_reboot() {
        let path = tmpfile("unavailable");
        let store = MockStore::unavailable();

        // First boot: keychain unavailable, no file → generate, write file.
        let (k1, fresh1) = load_or_create_boot_password_with(&store, &path).unwrap();
        assert!(fresh1, "no prior key anywhere ⇒ fresh");
        assert!(path.exists(), "file fallback should write the key");
        let on_disk = std::fs::read(&path).unwrap();
        assert_eq!(on_disk, k1);

        // Second boot: keychain still unavailable, file exists → reuse, NOT fresh.
        let (k2, fresh2) = load_or_create_boot_password_with(&store, &path).unwrap();
        assert!(!fresh2, "second boot must not quarantine the snapshot");
        assert_eq!(k1, k2);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn wrong_length_file_errors() {
        let path = tmpfile("wronglen");
        std::fs::write(&path, b"too-short").unwrap();
        let store = MockStore::empty();
        let res = load_or_create_boot_password_with(&store, &path);
        assert!(res.is_err(), "wrong-length file must error, not generate fresh");
        let _ = std::fs::remove_file(&path);
    }
}
