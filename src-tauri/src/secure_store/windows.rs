//! Windows backend — Credential Manager via `windows-rs`.
//!
//! Stores the boot key as a generic credential keyed by the target
//! name `"<SERVICE>:<ACCOUNT>"`. Persists with `CRED_PERSIST_LOCAL_MACHINE`
//! — survives reboots, never roams to other machines.
//!
//! This file can't be `cargo check`ed from a non-Windows host without
//! the MSVC SDK installed, so any divergence from the `windows = 0.58`
//! API will surface only on actual Windows builds.

use ::windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::FILETIME,
        Security::Credentials::{
            CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW,
            CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
        },
    },
};

use super::{SecureStoreError, ACCOUNT, LABEL, SERVICE};

// Win32 ERROR_NOT_FOUND (1168) wrapped as an HRESULT via FACILITY_WIN32.
const HRESULT_ERROR_NOT_FOUND: i32 = 0x8007_0490u32 as i32;

fn target_name_wide() -> Vec<u16> {
    let s = format!("{SERVICE}:{ACCOUNT}");
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn load() -> Result<Option<[u8; 32]>, SecureStoreError> {
    let target = target_name_wide();
    let mut cred_ptr: *mut CREDENTIALW = std::ptr::null_mut();
    let res = unsafe {
        CredReadW(
            PCWSTR(target.as_ptr()),
            CRED_TYPE_GENERIC,
            0,
            &mut cred_ptr,
        )
    };
    if let Err(e) = res {
        if e.code().0 == HRESULT_ERROR_NOT_FOUND {
            return Ok(None);
        }
        return Err(SecureStoreError::Backend(format!("CredReadW: {e}")));
    }

    let cred = unsafe { &*cred_ptr };
    let size = cred.CredentialBlobSize as usize;
    if size != 32 {
        unsafe { CredFree(cred_ptr as *const _) };
        return Err(SecureStoreError::Backend(format!(
            "credential blob has wrong length {size} (want 32)"
        )));
    }
    let mut out = [0u8; 32];
    unsafe {
        std::ptr::copy_nonoverlapping(cred.CredentialBlob, out.as_mut_ptr(), 32);
        CredFree(cred_ptr as *const _);
    }
    Ok(Some(out))
}

pub fn store(key: &[u8; 32]) -> Result<(), SecureStoreError> {
    let mut target = target_name_wide();
    let mut user = wide(ACCOUNT);
    let mut comment = wide(LABEL);
    // CredentialBlob isn't const-correct in the Win32 ABI; the API treats
    // it as `BYTE*`. Copy the key into a mutable local so the pointer is
    // valid for the duration of `CredWriteW`.
    let mut blob = *key;

    let cred = CREDENTIALW {
        Flags: ::windows::Win32::Security::Credentials::CRED_FLAGS(0),
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_mut_ptr()),
        Comment: PWSTR(comment.as_mut_ptr()),
        LastWritten: FILETIME::default(),
        CredentialBlobSize: 32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: PWSTR::null(),
        UserName: PWSTR(user.as_mut_ptr()),
    };

    unsafe { CredWriteW(&cred, 0) }
        .map_err(|e| SecureStoreError::Backend(format!("CredWriteW: {e}")))
}

pub fn delete() -> Result<(), SecureStoreError> {
    let target = target_name_wide();
    let res =
        unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, 0) };
    match res {
        Ok(()) => Ok(()),
        Err(e) if e.code().0 == HRESULT_ERROR_NOT_FOUND => Ok(()),
        Err(e) => Err(SecureStoreError::Backend(format!("CredDeleteW: {e}"))),
    }
}
