//! Import / export of the whole app data dir as a single backup file.
//!
//! A backup bundles everything that makes a Prmpt install portable:
//! `config.toml`, `prmpt.db` (hosts/keys/groups), `prmpt.stronghold`
//! (the encrypted SSH secrets) **and** the 32-byte Stronghold boot key
//! that decrypts that snapshot (pulled from the OS keyring, or the
//! legacy `stronghold.key` file). Without the boot key a restored
//! snapshot is unreadable, so it always travels with the backup — which
//! is exactly why the file can optionally be encrypted with a
//! passphrase (`age`, scrypt recipient). The bytes that hold the key to
//! every SSH credential should not sit on disk in the clear unless the
//! user opts into that.
//!
//! ## Why import is staged, not applied immediately
//!
//! `tauri-plugin-sql` holds `prmpt.db` open for the app's lifetime, so
//! overwriting it from a running process is unsafe (and outright fails
//! on Windows). `import_backup` therefore only *stages*: it decrypts,
//! unzips into `import_staging/`, and drops an `import_pending` marker.
//! The destructive swap happens in [`apply_pending_import`], called once
//! at startup **before** anything opens the DB; the frontend relaunches
//! the app right after a successful stage.

use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;
use zip::write::SimpleFileOptions;

use crate::error::{AppError, AppResult};
use crate::paths;
use crate::secure_store::{self, SecureStore};

/// Bumped if the archive layout changes incompatibly.
const FORMAT_VERSION: u32 = 1;

/// Live data-dir members copied into / restored from a backup. `config.toml`
/// regenerates from defaults if absent, the others are simply recreated by
/// the app, so it's safe to clear a member the backup doesn't contain.
const DATA_FILES: &[&str] = &["config.toml", "prmpt.db", "prmpt.stronghold", "data_version"];

/// Archive entry holding the boot key as 64 hex chars (not a live data-dir
/// file — the key lives in the OS keyring at runtime).
const BOOT_KEY_ENTRY: &str = "boot-key.hex";
const MANIFEST_ENTRY: &str = "manifest.json";

const STAGING_DIR: &str = "import_staging";
const PENDING_MARKER: &str = "import_pending";

/// Binary age files start with this; lets `import_backup` tell an
/// encrypted backup from a plain zip without a flag from the caller.
const AGE_MAGIC: &[u8] = b"age-encryption.org/v1";

#[derive(Serialize, Deserialize)]
struct Manifest {
    format: u32,
    app_version: String,
    /// True if `prmpt.stronghold` + `boot-key.hex` are present, i.e. the
    /// backup can restore decryptable SSH secrets.
    has_secrets: bool,
    files: Vec<String>,
}

/// Returned to the UI after a successful stage so it can phrase the
/// "restarting…" message accurately.
#[derive(Serialize)]
pub struct BackupSummary {
    pub encrypted: bool,
    pub has_secrets: bool,
}

// ---------- boot key helpers ----------

/// Best-effort fetch of the 32-byte Stronghold boot key: keyring first,
/// then the legacy `stronghold.key` file (64 hex chars). `None` means the
/// install has no secrets to protect (fresh profile) — the backup is then
/// config/db only.
fn read_boot_key() -> Option<[u8; 32]> {
    if let Ok(Some(key)) = secure_store::PlatformStore.load() {
        return Some(key);
    }
    let dir = paths::app_data_dir().ok()?;
    let raw = std::fs::read_to_string(dir.join("stronghold.key")).ok()?;
    let bytes = hex::decode(raw.trim()).ok()?;
    bytes.try_into().ok()
}

/// Put a restored boot key back where the next launch will look for it:
/// the keyring, falling back to the legacy file (the same precedence the
/// stronghold unlock path uses).
fn restore_boot_key(key: &[u8; 32]) {
    if secure_store::PlatformStore.store(key).is_err() {
        if let Ok(dir) = paths::ensure_app_data_dir() {
            let _ = std::fs::write(dir.join("stronghold.key"), hex::encode(key));
        }
    }
}

// ---------- export ----------

/// Build a backup of the current data dir and write it to `path`. If
/// `passphrase` is a non-empty string the whole archive is age-encrypted;
/// otherwise it's written as a plain zip (the UI warns the user that an
/// unencrypted backup contains the key to their SSH secrets).
#[tauri::command]
pub fn export_backup(
    app: tauri::AppHandle,
    path: String,
    passphrase: Option<String>,
) -> AppResult<()> {
    let dir = paths::app_data_dir()?;

    // Fold the WAL back into prmpt.db first. The live SQL pool runs in WAL
    // mode, so freshly committed rows (and on a small DB even the migrations
    // themselves) can still live in prmpt.db-wal while the main file lags
    // behind. We archive only prmpt.db, so without this the backup is a stale
    // snapshot and the un-checkpointed WAL is discarded on restore.
    let db = dir.join("prmpt.db");
    if db.exists() {
        checkpoint_wal(&db);
    }

    // Collect existing data files (skip missing — a fresh profile may not
    // have a stronghold snapshot yet).
    let mut members: Vec<(String, Vec<u8>)> = Vec::new();
    for name in DATA_FILES {
        let p = dir.join(name);
        if p.exists() {
            members.push((name.to_string(), std::fs::read(&p)?));
        }
    }

    // The boot key rides along (hex) so secrets are decryptable after a
    // restore. zeroize the raw bytes once they're hex-encoded.
    let mut has_secrets = false;
    if let Some(mut key) = read_boot_key() {
        let snapshot_present = members.iter().any(|(n, _)| n == "prmpt.stronghold");
        members.push((BOOT_KEY_ENTRY.to_string(), hex::encode(key).into_bytes()));
        key.zeroize();
        has_secrets = snapshot_present;
    }

    let manifest = Manifest {
        format: FORMAT_VERSION,
        app_version: app.package_info().version.to_string(),
        has_secrets,
        files: members.iter().map(|(n, _)| n.clone()).collect(),
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| AppError::Other(format!("serialize manifest: {e}")))?;

    // Zip everything into memory (Stored — no compression).
    let mut zip_bytes = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(Cursor::new(&mut zip_bytes));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let mut write_entry = |name: &str, data: &[u8]| -> AppResult<()> {
            zip.start_file(name, opts)
                .map_err(|e| AppError::Other(format!("zip {name}: {e}")))?;
            zip.write_all(data)
                .map_err(|e| AppError::Other(format!("zip {name}: {e}")))?;
            Ok(())
        };
        write_entry(MANIFEST_ENTRY, &manifest_bytes)?;
        for (name, data) in &members {
            write_entry(name, data)?;
        }
        zip.finish()
            .map_err(|e| AppError::Other(format!("finish zip: {e}")))?;
    }

    let out = match passphrase {
        Some(ref pass) if !pass.is_empty() => encrypt(&zip_bytes, pass)?,
        _ => zip_bytes,
    };
    std::fs::write(&path, &out)?;
    Ok(())
}

/// Also used by `sync.rs` to seal the WebDAV sync document.
pub(crate) fn encrypt(plaintext: &[u8], passphrase: &str) -> AppResult<Vec<u8>> {
    let encryptor =
        age::Encryptor::with_user_passphrase(age::secrecy::Secret::new(passphrase.to_owned()));
    let mut out = Vec::new();
    let mut writer = encryptor
        .wrap_output(&mut out)
        .map_err(|e| AppError::Crypto(format!("age init: {e}")))?;
    writer
        .write_all(plaintext)
        .map_err(|e| AppError::Crypto(format!("age write: {e}")))?;
    writer
        .finish()
        .map_err(|e| AppError::Crypto(format!("age finish: {e}")))?;
    Ok(out)
}

/// Also used by `sync.rs` to open the WebDAV sync document.
pub(crate) fn decrypt(ciphertext: &[u8], passphrase: &str) -> AppResult<Vec<u8>> {
    let decryptor = match age::Decryptor::new(ciphertext)
        .map_err(|e| AppError::Crypto(format!("age open: {e}")))?
    {
        age::Decryptor::Passphrase(d) => d,
        // Backups are always passphrase-encrypted (no key recipients).
        _ => return Err(AppError::Crypto("unexpected age recipient type".into())),
    };
    let mut reader = decryptor
        .decrypt(&age::secrecy::Secret::new(passphrase.to_owned()), None)
        .map_err(|_| AppError::Crypto("incorrect passphrase".into()))?;
    let mut out = Vec::new();
    reader
        .read_to_end(&mut out)
        .map_err(|e| AppError::Crypto(format!("age read: {e}")))?;
    Ok(out)
}

// ---------- import (stage) ----------

/// Sentinel returned when the chosen file is encrypted but no passphrase
/// was supplied. The frontend matches on this to prompt for one and retry
/// — distinct from a wrong-passphrase error so the UX can differ.
pub const ERR_NEEDS_PASSPHRASE: &str = "BACKUP_ENCRYPTED_NEEDS_PASSPHRASE";

/// Validate + decrypt + unzip a backup into the staging dir and drop the
/// pending marker. Does **not** touch live data — that swap happens at the
/// next startup in [`apply_pending_import`]. The caller relaunches the app
/// after this returns Ok.
#[tauri::command]
pub fn import_backup(path: String, passphrase: Option<String>) -> AppResult<BackupSummary> {
    let raw = std::fs::read(&path)?;

    let encrypted = raw.starts_with(AGE_MAGIC);
    let zip_bytes = if encrypted {
        let pass = match passphrase {
            Some(ref p) if !p.is_empty() => p,
            _ => return Err(AppError::Other(ERR_NEEDS_PASSPHRASE.into())),
        };
        decrypt(&raw, pass)?
    } else {
        raw
    };

    let dir = paths::ensure_app_data_dir()?;
    let staging = dir.join(STAGING_DIR);
    // Start clean so a previous aborted import can't leak stale files.
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;

    let extract_result = extract_into(&zip_bytes, &staging);
    let summary = match extract_result {
        Ok(s) => s,
        Err(e) => {
            // Don't leave half-extracted files (and no marker) around.
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };

    // Marker is written last: its presence is the signal that staging is
    // complete and safe to apply on the next boot.
    std::fs::write(dir.join(PENDING_MARKER), b"1")?;

    Ok(BackupSummary {
        encrypted,
        has_secrets: summary,
    })
}

/// Unzip into `staging`, validating the manifest. Only known entry names
/// are written (defends against path traversal / stray entries). Returns
/// `has_secrets` from the manifest.
fn extract_into(zip_bytes: &[u8], staging: &Path) -> AppResult<bool> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip_bytes))
        .map_err(|e| AppError::Other(format!("not a valid backup archive: {e}")))?;

    let allowed: Vec<&str> = DATA_FILES
        .iter()
        .copied()
        .chain([BOOT_KEY_ENTRY, MANIFEST_ENTRY])
        .collect();

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::Other(format!("read archive entry: {e}")))?;
        let name = entry.name().to_string();
        if !allowed.contains(&name.as_str()) {
            // Ignore anything we don't recognize rather than trust a path.
            continue;
        }
        let mut data = Vec::new();
        entry
            .read_to_end(&mut data)
            .map_err(|e| AppError::Other(format!("extract {name}: {e}")))?;
        std::fs::write(staging.join(&name), &data)?;
    }

    let manifest_raw = std::fs::read(staging.join(MANIFEST_ENTRY))
        .map_err(|_| AppError::Other("backup is missing its manifest".into()))?;
    let manifest: Manifest = serde_json::from_slice(&manifest_raw)
        .map_err(|e| AppError::Other(format!("invalid backup manifest: {e}")))?;
    if manifest.format > FORMAT_VERSION {
        return Err(AppError::Other(format!(
            "backup format {} is newer than this app supports ({FORMAT_VERSION})",
            manifest.format
        )));
    }
    Ok(manifest.has_secrets)
}

// ---------- apply (startup) ----------

/// Apply a staged import, if one is pending. Called once at startup before
/// any plugin opens the DB. Best-effort: a partial failure is logged, not
/// fatal, so a bad backup can't brick startup permanently (worst case the
/// user re-imports).
pub fn apply_pending_import() -> AppResult<()> {
    let dir = paths::app_data_dir()?;
    let marker = dir.join(PENDING_MARKER);
    if !marker.exists() {
        return Ok(());
    }
    let staging = dir.join(STAGING_DIR);

    for name in DATA_FILES {
        let dst = dir.join(name);
        let src = staging.join(name);
        // Clear the live file first so a member absent from the backup is
        // genuinely removed (import replaces all data, never merges).
        let _ = std::fs::remove_file(&dst);
        if src.exists() {
            move_file(&src, &dst);
        }
    }

    // The new prmpt.db must not inherit the previous DB's WAL/SHM sidecars.
    let _ = std::fs::remove_file(dir.join("prmpt.db-wal"));
    let _ = std::fs::remove_file(dir.join("prmpt.db-shm"));

    // The imported DB's recorded migration checksums may belong to a
    // different build; `db_compat::prepare_db` reconciles them right after
    // this returns (it runs every launch, before the SQL plugin opens the
    // DB), so no import-specific re-stamping is needed here.

    // Restore the boot key so the imported stronghold snapshot is
    // decryptable on this machine.
    if let Ok(hexstr) = std::fs::read_to_string(staging.join(BOOT_KEY_ENTRY)) {
        if let Ok(bytes) = hex::decode(hexstr.trim()) {
            if let Ok(mut arr) = <[u8; 32]>::try_from(bytes) {
                restore_boot_key(&arr);
                arr.zeroize();
            }
        }
    }

    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_file(&marker);
    eprintln!("[backup] applied pending import");
    Ok(())
}

/// Checkpoint the SQLite WAL into the main `prmpt.db` file so an export
/// captures every committed change. `wal_checkpoint(TRUNCATE)` flushes all
/// committed frames into the main file and empties `prmpt.db-wal`; it
/// coexists safely with the live plugin pool (a checkpoint blocked by an
/// active reader still folds in everything it can and returns without error).
///
/// Best-effort: failures are logged, not propagated — worst case the backup
/// is exactly as complete as the main file already was.
fn checkpoint_wal(db_path: &Path) {
    use sqlx::ConnectOptions;

    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[backup] wal checkpoint: runtime build failed: {e}");
            return;
        }
    };

    let result: Result<(), sqlx::Error> = rt.block_on(async {
        let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(db_path)
            .create_if_missing(false)
            .connect()
            .await?;
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&mut conn)
            .await?;
        Ok(())
    });

    if let Err(e) = result {
        eprintln!("[backup] wal checkpoint failed: {e}");
    }
}

/// Move within the data dir, falling back to copy+delete if `rename`
/// fails (shouldn't, since src/dst share a filesystem, but be defensive).
fn move_file(src: &Path, dst: &PathBuf) {
    if std::fs::rename(src, dst).is_ok() {
        return;
    }
    if std::fs::copy(src, dst).is_ok() {
        let _ = std::fs::remove_file(src);
    } else {
        eprintln!("[backup] failed to move {} into place", src.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::ConnectOptions;

    fn tmp_db(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        let pid = std::process::id();
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("prmpt-test-{pid}-{ts}-{name}.db"));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn checkpoint_flushes_wal_into_main_file() {
        let path = tmp_db("checkpoint");

        // Write a row in WAL mode but leave the WAL un-checkpointed, mirroring
        // the live app: the main file lags, the data lives in prmpt.db-wal.
        let setup = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        setup.block_on(async {
            let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true)
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
                // Disable auto-checkpoint so the write stays in the WAL until
                // checkpoint_wal runs — otherwise the test proves nothing.
                .pragma("wal_autocheckpoint", "0")
                .connect()
                .await
                .unwrap();
            sqlx::query("CREATE TABLE t (v INTEGER)")
                .execute(&mut conn)
                .await
                .unwrap();
            sqlx::query("INSERT INTO t (v) VALUES (42)")
                .execute(&mut conn)
                .await
                .unwrap();
            // A non-empty WAL is what the export needs folded in.
            assert!(
                path.with_extension("db-wal").metadata().map_or(false, |m| m.len() > 0),
                "row should still be sitting in the WAL before checkpoint"
            );
        });
        drop(setup);

        checkpoint_wal(&path);

        // Read the main file alone (no WAL) — exactly what export archives.
        let verify = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let v: i64 = verify.block_on(async {
            let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete)
                .connect()
                .await
                .unwrap();
            sqlx::query_scalar("SELECT v FROM t")
                .fetch_one(&mut conn)
                .await
                .unwrap()
        });
        assert_eq!(v, 42, "committed row must be in the main file after checkpoint");

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }
}
