/**
 * Secret storage layer — talks to the tauri-plugin-stronghold plugin
 * directly from JS. The Rust side just generates the boot password
 * (in `stronghold.key`) and exposes it via `get_stronghold_unlock`;
 * everything else (load, client, store CRUD, snapshot save) happens
 * here.
 *
 * Initialize once at app startup with `openSecrets()` before using any
 * of the load/save helpers.
 */

import { invoke } from "@tauri-apps/api/core";
import { Client, Store, Stronghold } from "@tauri-apps/plugin-stronghold";

interface StrongholdUnlock {
  snapshot_path: string;
  password: string;
  was_quarantined: boolean;
}

const CLIENT_NAME = "prmpt";

let stronghold: Stronghold | null = null;
let client: Client | null = null;
let wasQuarantined = false;

/**
 * Open (or create) the Stronghold snapshot. Resolves to `true` if the
 * snapshot was quarantined this boot (caller should run
 * `markAllBroken()`), `false` otherwise.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function openSecrets(): Promise<boolean> {
  if (stronghold) return wasQuarantined;
  const unlock = await invoke<StrongholdUnlock>("get_stronghold_unlock");
  wasQuarantined = unlock.was_quarantined;

  // On the initial load (no HMR), the Stronghold plugin's IPC channel
  // sometimes isn't ready by the time the JS bootstrap hits this call —
  // `Stronghold.load` then hangs waiting for a reply that never arrives.
  // The plugin warms up after a moment, so retry until it actually
  // responds. The timeout has to comfortably exceed real scrypt work:
  // iota_stronghold runs scrypt internally during `load()` and on debug
  // builds (even with `-O3` scrypt in Cargo.toml) that takes ~10 s.
  // 60 s leaves plenty of headroom for a genuinely slow machine while
  // still catching an IPC hang in a reasonable time.
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      stronghold = await withTimeout(
        Stronghold.load(unlock.snapshot_path, unlock.password),
        60_000,
        "Stronghold.load",
      );
      break;
    } catch (e) {
      if (attempt >= maxAttempts) throw e;
      console.warn(`[secrets] Stronghold.load attempt ${attempt} failed (${e}); retrying…`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    client = await stronghold.loadClient(CLIENT_NAME);
  } catch {
    client = await stronghold.createClient(CLIENT_NAME);
    await stronghold.save();
  }
  return wasQuarantined;
}

function store(): Store {
  if (!client) throw new Error("secrets not initialized — call openSecrets() first");
  return client.getStore();
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Save a UTF-8 string under `key`. Commits the snapshot to disk. */
export async function saveSecret(key: string, value: string): Promise<void> {
  await store().insert(key, Array.from(encoder.encode(value)));
  await stronghold!.save();
}

/** Read a UTF-8 string previously stored with `saveSecret`. */
export async function loadSecret(key: string): Promise<string | null> {
  const bytes = await store().get(key);
  if (!bytes) return null;
  return decoder.decode(new Uint8Array(bytes));
}

/** Remove a secret. Commits the snapshot to disk. */
export async function deleteSecret(key: string): Promise<void> {
  await store().remove(key);
  await stronghold!.save();
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
