//! macOS / iOS backend — Keychain Services via `security-framework`.
//!
//! Stores the boot key as a generic password keyed by
//! `(SERVICE, ACCOUNT)`. The default accessibility for generic passwords
//! on macOS keeps the item local to the keychain and excludes it from
//! iCloud Keychain unless `kSecAttrSynchronizable` is set, which we
//! never set.
//!
//! Notes:
//! - On iOS, an unsigned dev build or a build without keychain
//!   entitlements can fail with `errSecMissingEntitlement (-34018)`.
//!   Such failures bubble up as `SecureStoreError::Backend`; the caller
//!   logs and falls back to the legacy file path in the per-app sandbox.
//! - On macOS, changing the binary's signing identity (e.g. dev →
//!   notarized) triggers a fresh keychain access-control prompt because
//!   the ACL is identity-bound.

use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};

use super::{SecureStoreError, ACCOUNT, SERVICE};

const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

pub fn load() -> Result<Option<[u8; 32]>, SecureStoreError> {
    match get_generic_password(SERVICE, ACCOUNT) {
        Ok(bytes) => {
            let arr: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
                SecureStoreError::Backend(format!(
                    "keychain item has wrong length {} (want 32)",
                    bytes.len()
                ))
            })?;
            Ok(Some(arr))
        }
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        Err(e) => Err(SecureStoreError::Backend(format!("keychain read: {e}"))),
    }
}

pub fn store(key: &[u8; 32]) -> Result<(), SecureStoreError> {
    set_generic_password(SERVICE, ACCOUNT, key)
        .map_err(|e| SecureStoreError::Backend(format!("keychain write: {e}")))
}

pub fn delete() -> Result<(), SecureStoreError> {
    match delete_generic_password(SERVICE, ACCOUNT) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
        Err(e) => Err(SecureStoreError::Backend(format!(
            "keychain delete: {e}"
        ))),
    }
}
