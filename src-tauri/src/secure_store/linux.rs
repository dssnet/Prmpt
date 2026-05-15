//! Linux backend — Secret Service over D-Bus via the `secret-service` crate.
//!
//! When no Secret Service daemon is running (headless box, WSL without
//! GUI session, etc.) the `connect()` call fails. Those failures are
//! mapped to `SecureStoreError::Unavailable` so the caller silently
//! falls back to the legacy file path. Errors that occur *after* the
//! connection succeeds are mapped to `Backend` so they're logged loudly.
//!
//! This file can't be `cargo check`ed from a non-Linux host because the
//! crate's transitive dep `zbus` requires the platform's D-Bus headers,
//! so any API drift will surface only on actual Linux builds.

use std::collections::HashMap;

use secret_service::{EncryptionType, SecretService};

use super::{SecureStoreError, ACCOUNT, LABEL, SERVICE};

fn attrs() -> HashMap<&'static str, &'static str> {
    let mut m = HashMap::new();
    m.insert("service", SERVICE);
    m.insert("account", ACCOUNT);
    m
}

fn build_runtime() -> Result<tokio::runtime::Runtime, SecureStoreError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| SecureStoreError::Backend(format!("build tokio rt: {e}")))
}

pub fn load() -> Result<Option<[u8; 32]>, SecureStoreError> {
    let rt = build_runtime()?;
    rt.block_on(async {
        let ss = SecretService::connect(EncryptionType::Dh).await.map_err(
            |e| SecureStoreError::Unavailable(format!("secret service connect: {e}")),
        )?;
        let items = ss
            .search_items(attrs())
            .await
            .map_err(|e| SecureStoreError::Backend(format!("search_items: {e}")))?;
        let item = match items
            .unlocked
            .into_iter()
            .next()
            .or_else(|| items.locked.into_iter().next())
        {
            Some(i) => i,
            None => return Ok(None),
        };
        item.unlock()
            .await
            .map_err(|e| SecureStoreError::Backend(format!("unlock item: {e}")))?;
        let secret = item
            .get_secret()
            .await
            .map_err(|e| SecureStoreError::Backend(format!("get_secret: {e}")))?;
        let arr: [u8; 32] = secret.as_slice().try_into().map_err(|_| {
            SecureStoreError::Backend(format!(
                "secret service item has wrong length {} (want 32)",
                secret.len()
            ))
        })?;
        Ok(Some(arr))
    })
}

pub fn store(key: &[u8; 32]) -> Result<(), SecureStoreError> {
    let rt = build_runtime()?;
    rt.block_on(async {
        let ss = SecretService::connect(EncryptionType::Dh).await.map_err(
            |e| SecureStoreError::Unavailable(format!("secret service connect: {e}")),
        )?;
        let collection = ss.get_default_collection().await.map_err(|e| {
            SecureStoreError::Backend(format!("default collection: {e}"))
        })?;
        // Best-effort unlock — silent if already unlocked.
        let _ = collection.unlock().await;
        collection
            .create_item(
                LABEL,
                attrs(),
                key,
                true, // replace existing
                "application/octet-stream",
            )
            .await
            .map_err(|e| SecureStoreError::Backend(format!("create_item: {e}")))?;
        Ok(())
    })
}

pub fn delete() -> Result<(), SecureStoreError> {
    let rt = build_runtime()?;
    rt.block_on(async {
        let ss = SecretService::connect(EncryptionType::Dh).await.map_err(
            |e| SecureStoreError::Unavailable(format!("secret service connect: {e}")),
        )?;
        let items = ss
            .search_items(attrs())
            .await
            .map_err(|e| SecureStoreError::Backend(format!("search_items: {e}")))?;
        for item in items
            .unlocked
            .into_iter()
            .chain(items.locked.into_iter())
        {
            item.delete()
                .await
                .map_err(|e| SecureStoreError::Backend(format!("delete: {e}")))?;
        }
        Ok(())
    })
}
