//! Startup compatibility shim for `prmpt.db`'s migration bookkeeping.
//!
//! sqlx aborts DB init when `_sqlx_migrations` disagrees with the compiled-in
//! migration list in either direction:
//!
//! 1. an applied version is missing from the resolved list — "migration N was
//!    previously applied but is missing in the resolved migrations". Happens
//!    whenever a *newer* build (e.g. `bun tauri dev` with an unreleased
//!    migration) has touched the DB and an older installed build opens it
//!    next.
//! 2. a stored SHA-384 checksum no longer matches the SQL this binary
//!    compiled in — "migration N ... has been modified". Happens when a
//!    restored backup carries another build's checksums.
//!
//! [`prepare_db`] runs once per launch, before the SQL plugin is built, and
//! neutralizes both: it re-stamps every known migration's checksum to
//! `Sha384(current SQL)` and, for applied versions *beyond* what this binary
//! knows, synthesizes no-op placeholder [`Migration`]s (re-stamping those
//! rows to the placeholder text's hash). sqlx then sees a fully consistent,
//! fully-applied history and executes nothing.
//!
//! Sound only because migrations are append-only and additive (see Hard rules
//! in CLAUDE.md): an older binary can safely ignore columns and tables it
//! doesn't know about. Checksum validation becomes advisory by design.

use std::path::Path;

use tauri_plugin_sql::{Migration, MigrationKind};

/// Reconcile `_sqlx_migrations` with this binary's [`crate::MIGRATIONS`] and
/// return placeholder migrations for applied-but-unknown future versions.
///
/// Best-effort: any failure is logged and yields an empty vec, falling back
/// to plain "known migrations only" behavior so a quirky DB can't brick
/// startup harder than it already would.
pub fn prepare_db(db_path: &Path) -> Vec<Migration> {
    if !db_path.exists() {
        // Fresh install — the plugin creates the DB and runs everything.
        return Vec::new();
    }

    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[db-compat] runtime build failed: {e}");
            return Vec::new();
        }
    };

    match rt.block_on(reconcile(db_path)) {
        Ok(placeholders) => {
            for m in &placeholders {
                eprintln!(
                    "[db-compat] DB has migration {} from a newer build; \
                     registering placeholder so init can proceed",
                    m.version
                );
            }
            placeholders
        }
        Err(e) => {
            eprintln!("[db-compat] reconcile failed: {e}; opening with known migrations only");
            Vec::new()
        }
    }
}

async fn reconcile(db_path: &Path) -> Result<Vec<Migration>, sqlx::Error> {
    use sha2::{Digest, Sha384};
    use sqlx::ConnectOptions;

    let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(false)
        .connect()
        .await?;

    // No migration table yet → pre-migration DB; the plugin will create it
    // and run everything. Nothing to reconcile.
    let exists: Option<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_optional(&mut conn)
    .await?;
    if exists.is_none() {
        return Ok(Vec::new());
    }

    // Re-stamp every known, already-recorded version to this binary's SQL
    // hash. Rows that don't exist are untouched (UPDATE matches nothing) and
    // sqlx runs those migrations normally.
    for &(version, _desc, sql) in crate::MIGRATIONS {
        let checksum = Sha384::digest(sql.as_bytes()).to_vec();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ?1 WHERE version = ?2")
            .bind(checksum)
            .bind(version)
            .execute(&mut conn)
            .await?;
    }

    // Applied versions beyond this binary's knowledge. No `success` filter —
    // sqlx's own applied-migrations query ignores that column, so mirror its
    // view of what counts as applied.
    let max_known = crate::MIGRATIONS.iter().map(|&(v, ..)| v).max().unwrap_or(0);
    let future: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE version > ?1 ORDER BY version")
            .bind(max_known)
            .fetch_all(&mut conn)
            .await?;

    let mut placeholders = Vec::with_capacity(future.len());
    for version in future {
        let sql = format!(
            "-- migration {version} applied by a newer Prmpt build; \
             schema is already in place (migrations are append-only)"
        );
        let checksum = Sha384::digest(sql.as_bytes()).to_vec();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ?1 WHERE version = ?2")
            .bind(checksum)
            .bind(version)
            .execute(&mut conn)
            .await?;

        // The plugin's Migration wants &'static str; leak the handful of
        // generated strings — bounded by future-version count, once per
        // launch.
        placeholders.push(Migration {
            version,
            description: Box::leak(format!("future_v{version}_placeholder").into_boxed_str()),
            sql: Box::leak(sql.into_boxed_str()),
            kind: MigrationKind::Up,
        });
    }
    Ok(placeholders)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha384};
    use sqlx::ConnectOptions;
    use std::path::PathBuf;

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

    // Mirrors the table sqlx's sqlite migrator creates.
    const MIGRATIONS_TABLE: &str = "CREATE TABLE _sqlx_migrations (\
         version BIGINT PRIMARY KEY, description TEXT NOT NULL, \
         installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, \
         success BOOLEAN NOT NULL, checksum BLOB NOT NULL, \
         execution_time BIGINT NOT NULL)";

    #[test]
    fn missing_db_yields_no_placeholders() {
        let path = tmp_db("missing");
        assert!(prepare_db(&path).is_empty());
        assert!(!path.exists(), "prepare_db must not create the DB");
    }

    #[test]
    fn restamps_known_and_placeholders_future_versions() {
        let path = tmp_db("future");

        // Seed the state an older binary finds after a newer build ran: a
        // stale checksum on a known migration plus an unknown version 99.
        let setup = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        setup.block_on(async {
            let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true)
                .connect()
                .await
                .unwrap();
            sqlx::query(MIGRATIONS_TABLE).execute(&mut conn).await.unwrap();
            for version in [1i64, 99] {
                sqlx::query(
                    "INSERT INTO _sqlx_migrations \
                     (version, description, success, checksum, execution_time) \
                     VALUES (?1, 'seeded', 1, ?2, 0)",
                )
                .bind(version)
                .bind(b"stale".to_vec())
                .execute(&mut conn)
                .await
                .unwrap();
            }
        });
        drop(setup);

        // Builds its own runtime internally — must not be called from within
        // a block_on, hence the drop above.
        let placeholders = prepare_db(&path);
        assert_eq!(placeholders.len(), 1);
        assert_eq!(placeholders[0].version, 99);

        let verify = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (v1, v99): (Vec<u8>, Vec<u8>) = verify.block_on(async {
            let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .connect()
                .await
                .unwrap();
            let v1 = sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = 1")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            let v99 = sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = 99")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            (v1, v99)
        });

        let expected_v1 = Sha384::digest(crate::MIGRATIONS[0].2.as_bytes()).to_vec();
        assert_eq!(v1, expected_v1, "known version re-stamped to current SQL");
        let expected_v99 = Sha384::digest(placeholders[0].sql.as_bytes()).to_vec();
        assert_eq!(v99, expected_v99, "future version re-stamped to placeholder SQL");

        let _ = std::fs::remove_file(&path);
    }
}
