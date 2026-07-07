//! WebDAV transport for cross-device sync.
//!
//! The sync *engine* (record merge, conflict resolution, applying changes
//! to the DB) lives in the frontend (`src/state/sync.ts`) next to the rest
//! of the host/key/group CRUD. This module only moves bytes: it GETs and
//! PUTs one file — `prmpt-sync.age` inside the user-supplied WebDAV
//! collection — and encrypts/decrypts it with the user's end-to-end
//! passphrase (age scrypt, same primitives as `backup.rs`). The document
//! carries every synced secret (host passwords, private keys), so pushing
//! without a passphrase is refused outright; the WebDAV server never sees
//! plaintext.
//!
//! Concurrent writers (two devices pushing at once) are handled with HTTP
//! preconditions: a push sends `If-Match: <etag of the revision it merged
//! against>` (or `If-None-Match: *` when creating the file), and a 412
//! comes back as the [`ERR_CONFLICT`] sentinel so the frontend re-pulls,
//! re-merges and retries. Nothing is ever overwritten blind.

use serde::{Deserialize, Serialize};

use crate::backup;
use crate::error::{AppError, AppResult};

/// Sentinel error string for a push that lost the race against another
/// device (HTTP 412). The frontend matches on this to re-pull + re-merge
/// instead of surfacing an error.
pub const ERR_CONFLICT: &str = "SYNC_CONFLICT";

/// The one file this app owns inside the user's WebDAV collection.
const SYNC_FILENAME: &str = "prmpt-sync.age";

const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Deserialize, Clone)]
pub struct WebdavParams {
    /// URL of an existing WebDAV collection (directory), e.g.
    /// `https://cloud.example.com/remote.php/dav/files/user/prmpt/`.
    pub url: String,
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct SyncPullResult {
    /// True when the server answered 304 to our `If-None-Match` — the
    /// remote document is unchanged since `cached_etag`, `data` is absent.
    pub not_modified: bool,
    /// Decrypted document JSON; `None` when the file doesn't exist yet.
    pub data: Option<String>,
    pub etag: Option<String>,
}

/// The user-supplied collection URL, normalized to end in `/` so `join`
/// appends rather than replaces the last path segment.
fn collection_url(raw: &str) -> AppResult<reqwest::Url> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Other("WebDAV URL is empty".into()));
    }
    let with_slash = if trimmed.ends_with('/') {
        trimmed.to_string()
    } else {
        format!("{trimmed}/")
    };
    let url = reqwest::Url::parse(&with_slash)
        .map_err(|e| AppError::Other(format!("invalid WebDAV URL: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::Other(
            "WebDAV URL must start with http:// or https://".into(),
        ));
    }
    Ok(url)
}

fn file_url(raw: &str) -> AppResult<reqwest::Url> {
    collection_url(raw)?
        .join(SYNC_FILENAME)
        .map_err(|e| AppError::Other(format!("invalid WebDAV URL: {e}")))
}

fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| AppError::Other(format!("http client: {e}")))
}

fn with_auth(req: reqwest::RequestBuilder, p: &WebdavParams) -> reqwest::RequestBuilder {
    if p.username.is_empty() {
        req
    } else {
        req.basic_auth(&p.username, Some(&p.password))
    }
}

fn net_err(context: &str, e: reqwest::Error) -> AppError {
    // reqwest's Display nests the full URL incl. userinfo-free path — fine
    // to surface, but strip the noise down to the useful cause chain.
    let mut msg = e.to_string();
    let mut src: Option<&dyn std::error::Error> = std::error::Error::source(&e);
    while let Some(cause) = src {
        msg = format!("{msg}: {cause}");
        src = cause.source();
    }
    AppError::Other(format!("{context}: {msg}"))
}

fn status_err(context: &str, status: reqwest::StatusCode) -> AppError {
    let hint = match status.as_u16() {
        401 => " — check the username and password",
        403 => " — the account lacks permission on that folder",
        404 => " — folder not found, check the URL",
        405 | 501 => " — the server doesn't look like a WebDAV collection",
        507 => " — the server is out of storage",
        _ => "",
    };
    AppError::Other(format!("{context}: server returned {status}{hint}"))
}

fn etag_of(resp: &reqwest::Response) -> Option<String> {
    resp.headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// Probe the collection with `PROPFIND Depth: 0` — the canonical "is this
/// a WebDAV collection I can talk to" request (plain HTTP servers answer
/// 405/501, bad credentials 401).
#[tauri::command]
pub async fn sync_webdav_test(params: WebdavParams) -> AppResult<()> {
    let url = collection_url(&params.url)?;
    let method = reqwest::Method::from_bytes(b"PROPFIND")
        .map_err(|e| AppError::Other(format!("PROPFIND method: {e}")))?;
    let req = with_auth(client()?.request(method, url), &params).header("Depth", "0");
    let resp = req
        .send()
        .await
        .map_err(|e| net_err("connection failed", e))?;
    let status = resp.status();
    // 207 Multi-Status is the WebDAV success; accept any 2xx for lenient
    // servers/proxies.
    if status.is_success() || status.as_u16() == 207 {
        Ok(())
    } else {
        Err(status_err("connection test failed", status))
    }
}

/// Fetch + decrypt the remote sync document. `cached_etag` (the ETag of
/// the last revision this device saw) turns the common no-change poll into
/// a cheap 304.
#[tauri::command]
pub async fn sync_webdav_pull(
    params: WebdavParams,
    passphrase: String,
    cached_etag: Option<String>,
) -> AppResult<SyncPullResult> {
    let url = file_url(&params.url)?;
    let mut req = with_auth(client()?.get(url), &params);
    if let Some(tag) = cached_etag.filter(|t| !t.is_empty()) {
        req = req.header(reqwest::header::IF_NONE_MATCH, tag);
    }
    let resp = req.send().await.map_err(|e| net_err("sync pull", e))?;
    let status = resp.status();

    if status == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(SyncPullResult {
            not_modified: true,
            data: None,
            etag: None,
        });
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        // First sync against this server: no document yet.
        return Ok(SyncPullResult {
            not_modified: false,
            data: None,
            etag: None,
        });
    }
    if !status.is_success() {
        return Err(status_err("sync pull", status));
    }

    let etag = etag_of(&resp);
    let bytes = resp.bytes().await.map_err(|e| net_err("sync pull", e))?;
    if bytes.is_empty() {
        // A zero-byte file (e.g. a client that died mid-PUT) is treated as
        // absent; the next push overwrites it.
        return Ok(SyncPullResult {
            not_modified: false,
            data: None,
            etag,
        });
    }
    let plain = backup::decrypt(&bytes, &passphrase)?;
    let data = String::from_utf8(plain)
        .map_err(|_| AppError::Other("sync document is not valid UTF-8".into()))?;
    Ok(SyncPullResult {
        not_modified: false,
        data: Some(data),
        etag,
    })
}

/// Encrypt + upload the sync document, guarded so we never clobber a
/// revision we haven't merged: `base_etag` (from the pull this push is
/// based on) becomes `If-Match`; no base means "the file must not exist
/// yet" (`If-None-Match: *`). A 412 surfaces as [`ERR_CONFLICT`].
///
/// Returns the new revision's ETag when the server reports one (directly
/// on the PUT or via a follow-up HEAD); `None` just means the next pull
/// can't use the 304 shortcut.
#[tauri::command]
pub async fn sync_webdav_push(
    params: WebdavParams,
    passphrase: String,
    data: String,
    base_etag: Option<String>,
) -> AppResult<Option<String>> {
    if passphrase.is_empty() {
        // The document carries SSH passwords and private keys — refusing
        // here (not just in the UI) guarantees no plaintext ever leaves.
        return Err(AppError::Other(
            "sync requires an end-to-end encryption passphrase".into(),
        ));
    }
    let cipher = backup::encrypt(data.as_bytes(), &passphrase)?;
    let url = file_url(&params.url)?;

    let mut req = with_auth(client()?.put(url.clone()), &params)
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .body(cipher);
    match base_etag.filter(|t| !t.is_empty()) {
        Some(tag) => req = req.header(reqwest::header::IF_MATCH, tag),
        None => req = req.header(reqwest::header::IF_NONE_MATCH, "*"),
    }
    let resp = req.send().await.map_err(|e| net_err("sync push", e))?;
    let status = resp.status();

    if status == reqwest::StatusCode::PRECONDITION_FAILED {
        return Err(AppError::Other(ERR_CONFLICT.into()));
    }
    if !status.is_success() {
        return Err(status_err("sync push", status));
    }

    if let Some(tag) = etag_of(&resp) {
        return Ok(Some(tag));
    }
    // Some servers omit the ETag on PUT; ask for it. Best-effort — a racing
    // writer between PUT and HEAD would hand us its etag, but the next pull
    // then simply sees "changed" and re-merges, which is always safe.
    let head = with_auth(client()?.head(url), &params)
        .send()
        .await
        .map_err(|e| net_err("sync push (etag probe)", e))?;
    if head.status().is_success() {
        Ok(etag_of(&head))
    } else {
        Ok(None)
    }
}
