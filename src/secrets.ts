/**
 * Secret storage layer — talks to the Rust-side `SecretStore`
 * (`src-tauri/src/secret_store.rs`) via Tauri commands. Rust owns the
 * `iota_stronghold` instance and loads its snapshot lazily on first
 * secret access, so the scrypt-heavy decrypt happens at most once per
 * process regardless of how many windows are open.
 *
 * Note: `openSecrets()` no longer does any work other than reporting
 * the quarantine flag. Kept for the main.ts boot path; everything else
 * just calls `secret_get` / `secret_set` / `secret_remove` directly.
 */

import { invoke } from "@tauri-apps/api/core";

interface StrongholdUnlock {
  snapshot_path: string;
  password: string;
  was_quarantined: boolean;
}

/**
 * Check whether this boot quarantined a stale snapshot. The boot
 * password lives in the platform keychain; if it was regenerated
 * since the snapshot was last written, the snapshot is undecryptable
 * and gets moved aside (see `stronghold::prepare_unlock` in Rust).
 * Resolves to `true` in that case (caller should run `markAllBroken`).
 */
export async function openSecrets(): Promise<boolean> {
  const unlock = await invoke<StrongholdUnlock>("get_stronghold_unlock");
  return unlock.was_quarantined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Save a UTF-8 string under `key`. Commits the snapshot to disk. */
export async function saveSecret(key: string, value: string): Promise<void> {
  await invoke("secret_set", { key, value: Array.from(encoder.encode(value)) });
}

/** Read a UTF-8 string previously stored with `saveSecret`. */
export async function loadSecret(key: string): Promise<string | null> {
  const bytes = await invoke<number[] | null>("secret_get", { key });
  if (!bytes) return null;
  return decoder.decode(new Uint8Array(bytes));
}

/** Remove a secret. Commits the snapshot to disk. */
export async function deleteSecret(key: string): Promise<void> {
  await invoke("secret_remove", { key });
}

// ---------- record-key helpers ----------

export function hostPasswordKey(hostId: number): string {
  return `host:${hostId}:password`;
}

export function keyPrivateKey(keyId: number): string {
  return `key:${keyId}:private`;
}

export function keyPassphraseKey(keyId: number): string {
  return `key:${keyId}:passphrase`;
}
