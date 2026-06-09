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
//!
//! The keychain itself is hit at most once per process per outcome:
//! a static [`UnlockCache`] memoizes both successes and failures so the
//! boot-time call sites (Rust startup + per-window IPC) share one
//! prompt. [`prepare_unlock_refresh`] is the only path that re-prompts
//! on a cached failure — used by the secret store so a user who
//! declined at boot can retry by initiating an SSH connect.

use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
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

/// Process-wide cache for the boot-time unlock. Ensures the platform
/// keychain is hit at most once per process for a given outcome — the
/// boot-eager call, the per-window `get_stronghold_unlock` IPC, and the
/// SSH-credential-fetch path all share the same cached state instead of
/// each triggering their own keychain prompt.
///
/// `Pending` is the initial state. A first successful attempt populates
/// `Success`; a failure populates `Failed`. [`prepare_unlock_cached`]
/// returns either cached variant without re-prompting; the secret store
/// uses [`prepare_unlock_refresh`] which re-attempts on `Failed` so a
/// user who declined at boot can retry by initiating an SSH connect.
enum UnlockCache {
    Pending,
    Success(StrongholdUnlock),
    Failed(String),
}

static CACHE: OnceLock<Mutex<UnlockCache>> = OnceLock::new();

fn cache_lock() -> std::sync::MutexGuard<'static, UnlockCache> {
    let m = CACHE.get_or_init(|| Mutex::new(UnlockCache::Pending));
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Return the cached unlock if any prior attempt this process has
/// resolved (success **or** failure). Only if the cache is still
/// `Pending` do we actually hit the keychain.
///
/// Use this from boot-time call sites — Rust startup
/// (`lib.rs::run`) and the per-window `get_stronghold_unlock` IPC —
/// where the goal is to learn the result without re-prompting.
pub fn prepare_unlock_cached() -> AppResult<StrongholdUnlock> {
    prepare_unlock_cached_inner(&PlatformStore, &boot_password_path()?, &snapshot_path()?)
}

/// Return the cached unlock if a prior attempt succeeded; otherwise
/// re-attempt (which on macOS triggers the keychain prompt). Use this
/// from user-initiated paths — specifically `SecretStore::ensure_loaded`
/// when an SSH connect needs a credential — so a user who declined the
/// boot-time prompt gets a fresh chance to approve rather than being
/// locked out for the process lifetime.
pub fn prepare_unlock_refresh() -> AppResult<StrongholdUnlock> {
    prepare_unlock_refresh_inner(&PlatformStore, &boot_password_path()?, &snapshot_path()?)
}

fn prepare_unlock_cached_inner<S: SecureStore>(
    store: &S,
    boot_password_path: &Path,
    snapshot_path: &Path,
) -> AppResult<StrongholdUnlock> {
    let mut guard = cache_lock();
    match &*guard {
        UnlockCache::Success(u) => return Ok(u.clone()),
        UnlockCache::Failed(msg) => return Err(AppError::Crypto(msg.clone())),
        UnlockCache::Pending => {}
    }
    let result = do_prepare_unlock(store, boot_password_path, snapshot_path);
    *guard = match &result {
        Ok(u) => UnlockCache::Success(u.clone()),
        Err(e) => UnlockCache::Failed(e.to_string()),
    };
    result
}

fn prepare_unlock_refresh_inner<S: SecureStore>(
    store: &S,
    boot_password_path: &Path,
    snapshot_path: &Path,
) -> AppResult<StrongholdUnlock> {
    let mut guard = cache_lock();
    if let UnlockCache::Success(u) = &*guard {
        return Ok(u.clone());
    }
    let result = do_prepare_unlock(store, boot_password_path, snapshot_path);
    *guard = match &result {
        Ok(u) => UnlockCache::Success(u.clone()),
        Err(e) => UnlockCache::Failed(e.to_string()),
    };
    result
}

/// Prepare the on-disk state needed to decrypt the snapshot: ensure a
/// boot password exists and quarantine the snapshot if the password is
/// fresh. The store and paths are parameters so unit tests can exercise
/// the logic against `MockStore` + temp dirs without touching the real
/// keychain or app data directory.
fn do_prepare_unlock<S: SecureStore>(
    store: &S,
    boot_password_path: &Path,
    snapshot_path: &Path,
) -> AppResult<StrongholdUnlock> {
    let (password_bytes, password_was_fresh) =
        load_or_create_boot_password_with(store, boot_password_path)?;
    let mut quarantined = false;

    // Fresh boot password + existing snapshot ⇒ snapshot was encrypted
    // with some other key and can't be decrypted with what we have.
    // Move it aside before the JS plugin wastes seconds of scrypt
    // trying to open it.
    if password_was_fresh && snapshot_path.exists() {
        let aside = quarantine_path(snapshot_path);
        eprintln!(
            "[stronghold] fresh boot password but snapshot exists; \
             quarantining {} → {} (old secrets are unrecoverable)",
            snapshot_path.display(),
            aside.display(),
        );
        std::fs::rename(snapshot_path, &aside).map_err(|e| {
            AppError::Crypto(format!(
                "rename orphan snapshot to {}: {e}",
                aside.display()
            ))
        })?;
        quarantined = true;
    }

    Ok(StrongholdUnlock {
        snapshot_path: snapshot_path.display().to_string(),
        password: hex::encode(&password_bytes),
        was_quarantined: quarantined,
    })
}

/// Drop the cache back to `Pending`. Test-only — production callers
/// rely on the once-per-process semantics.
#[cfg(test)]
fn reset_cache_for_tests() {
    *cache_lock() = UnlockCache::Pending;
}

/// `(password_bytes, freshly_generated)`. `freshly_generated` is `true`
/// **only** when neither the platform secret store nor the legacy file
/// held a key — i.e. when the snapshot (if any) can't possibly be
/// decrypted with what we have. Migrating an existing key from the file
/// into the secret store does *not* count as freshly-generated: the key
/// itself is unchanged.
fn load_or_create_boot_password_with<S: SecureStore>(
    store: &S,
    file: &Path,
) -> AppResult<(Vec<u8>, bool)> {
    // Tracks the user-denied / keychain-locked case (e.g. user cancels
    // the macOS keychain auth prompt). The key may still live in the
    // keychain — we just couldn't read it this session. Critically
    // different from `Ok(None)` (no key) and `Unavailable` (no backend):
    // we must NOT generate a fresh key here, because doing so would
    // quarantine the existing snapshot (rendering all saved SSH secrets
    // unrecoverable) over a recoverable, retry-on-relaunch error.
    let mut keychain_denied = false;

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
            keychain_denied = true;
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

    // Bail before generating a fresh key when the keychain refused
    // access and there's no legacy file to fall back on. The existing
    // snapshot stays untouched on disk so the next launch (with a
    // successful keychain prompt) recovers the user's saved secrets.
    if keychain_denied {
        return Err(AppError::Crypto(
            "platform keychain refused access; not generating a fresh boot key \
             to avoid quarantining the existing snapshot — relaunch and approve \
             the keychain prompt"
                .into(),
        ));
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
    #[cfg(windows)]
    restrict_acl_to_current_user(path);
    Ok(())
}

/// Unix gets 0o600 at open time; Windows files inherit the parent ACL, which
/// typically lets other authenticated users read them. Strip inheritance and
/// grant only the current user. Best-effort: the keychain already failed when
/// this fallback runs, so a logged warning beats not persisting the key.
#[cfg(windows)]
fn restrict_acl_to_current_user(path: &Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let user = match std::env::var("USERNAME") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            eprintln!(
                "[secure_store] USERNAME unset; leaving default ACL on {}",
                path.display()
            );
            return;
        }
    };
    let result = std::process::Command::new("icacls")
        .arg(path)
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg(format!("{user}:F"))
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    match result {
        Ok(s) if s.success() => {}
        Ok(s) => eprintln!("[secure_store] icacls on {} exited with {s}", path.display()),
        Err(e) => eprintln!("[secure_store] icacls on {} failed: {e}", path.display()),
    }
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
    fn keychain_denied_with_no_legacy_returns_err_and_does_not_touch_store() {
        // Models: user cancels macOS keychain prompt at startup and
        // there's no legacy stronghold.key file to fall back on. The
        // call MUST fail rather than silently generate fresh, because
        // `prepare_unlock` reads the fresh flag to decide whether to
        // quarantine the (still-good) snapshot.
        let path = tmpfile("denied");
        let store = MockStore::denied();

        let res = load_or_create_boot_password_with(&store, &path);
        assert!(res.is_err(), "denied keychain + no legacy file must error");
        assert!(
            !path.exists(),
            "must not write a legacy file on the denied path"
        );
        assert!(
            store.stored_key().is_none(),
            "denied keychain must not be clobbered with a fresh key"
        );
    }

    #[test]
    fn keychain_denied_with_legacy_uses_legacy_and_is_not_fresh() {
        // Models: user cancels keychain prompt but a legacy
        // stronghold.key file from a pre-keychain install is on disk.
        // Loading must succeed against the legacy file and return
        // `fresh = false` so prepare_unlock doesn't quarantine.
        let path = tmpfile("denied_legacy");
        let mut legacy_key = [0u8; 32];
        for (i, b) in legacy_key.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(3);
        }
        std::fs::write(&path, legacy_key).unwrap();

        let store = MockStore::denied();
        let (k, fresh) = load_or_create_boot_password_with(&store, &path).unwrap();

        assert!(!fresh, "legacy-file load must not flag fresh");
        assert_eq!(k.as_slice(), legacy_key.as_slice());
        assert!(
            path.exists(),
            "denied store can't migrate, legacy file must stay in place"
        );
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

    // All cache assertions live in a single test because the cache is a
    // process-wide static; `cargo test` runs tests in parallel and any
    // sibling test exercising the cache would race. Sub-sections use
    // `reset_cache_for_tests` to start each one from `Pending`.
    #[test]
    fn cache_behavior() {
        // Section 1: cached path serves repeated callers from one keychain hit.
        {
            reset_cache_for_tests();
            let snap = tmpfile("cache-1-snap"); // never created → no quarantine
            let pw_path = tmpfile("cache-1-pw");
            let store = MockStore::empty();

            let u1 = prepare_unlock_cached_inner(&store, &pw_path, &snap).unwrap();
            let u2 = prepare_unlock_cached_inner(&store, &pw_path, &snap).unwrap();
            assert_eq!(u1.password, u2.password);
            assert_eq!(
                store.load_count(),
                1,
                "second cached call must not hit the keychain"
            );
            let _ = std::fs::remove_file(&pw_path);
        }

        // Section 2: cached failure stays cached — no retry, no re-prompt.
        {
            reset_cache_for_tests();
            let snap = tmpfile("cache-2-snap");
            let pw_path = tmpfile("cache-2-pw");
            let store = MockStore::denied();

            assert!(prepare_unlock_cached_inner(&store, &pw_path, &snap).is_err());
            assert!(prepare_unlock_cached_inner(&store, &pw_path, &snap).is_err());
            assert_eq!(
                store.load_count(),
                1,
                "cached Failed must not re-attempt"
            );
        }

        // Section 3: refresh re-attempts after a cached failure — that's
        // what gives the SSH-connect path a fresh keychain prompt.
        {
            reset_cache_for_tests();
            let snap = tmpfile("cache-3-snap");
            let pw_path = tmpfile("cache-3-pw");
            let store = MockStore::denied();

            assert!(prepare_unlock_cached_inner(&store, &pw_path, &snap).is_err());
            assert_eq!(store.load_count(), 1);
            assert!(prepare_unlock_refresh_inner(&store, &pw_path, &snap).is_err());
            assert_eq!(
                store.load_count(),
                2,
                "refresh after Failed must re-prompt"
            );
        }

        // Section 4: refresh after a cached success skips the keychain.
        {
            reset_cache_for_tests();
            let snap = tmpfile("cache-4-snap");
            let pw_path = tmpfile("cache-4-pw");
            let store = MockStore::empty();

            let u1 = prepare_unlock_cached_inner(&store, &pw_path, &snap).unwrap();
            let u2 = prepare_unlock_refresh_inner(&store, &pw_path, &snap).unwrap();
            assert_eq!(u1.password, u2.password);
            assert_eq!(
                store.load_count(),
                1,
                "refresh after Success must return cached value"
            );
            let _ = std::fs::remove_file(&pw_path);
        }

        // Leave the cache empty for any subsequent test invocations.
        reset_cache_for_tests();
    }
}
