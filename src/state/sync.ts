/**
 * WebDAV sync engine.
 *
 * One age-encrypted JSON document (`prmpt-sync.age`) lives in a WebDAV
 * collection; every device pointed at the same collection + end-to-end
 * passphrase converges on the same hosts / keys / groups (secrets
 * included — they travel inside the encrypted document, the server never
 * sees plaintext). The Rust side (`src-tauri/src/sync.rs`) only does
 * HTTP + crypto; everything else happens here:
 *
 *  - records are identified by `sync_id` (UUID per row, assigned on
 *    insert in db.ts, backfilled by migration 0008 / `backfillSyncIds`)
 *  - merge is per-record last-write-wins on `updated_at`, with
 *    tombstones so deletions beat stale copies (`sync_tombstones`)
 *  - port forwards are embedded in their host's record (db.ts bumps the
 *    host's `updated_at` on any forward change)
 *  - device-local state (a group's expanded flag, `broken` markers, the
 *    hide-PIN, config.toml) deliberately stays out of the document
 *
 * A sync cycle: pull (ETag-cached) → merge remote with a local snapshot →
 * apply what changed locally → push the merged doc with `If-Match` when
 * it differs from remote. A 412 (another device pushed in between) just
 * re-runs the cycle. Cycles run on startup, debounced after local edits
 * (db.ts mutation hook), on window focus, and on a timer while focused.
 */

import { ref } from "vue";

import { dbHandle, setDbMutationListener } from "../db";
import {
  currentWindowLabel,
  SYNC_CONFLICT,
  syncWebdavPull,
  syncWebdavPush,
  syncWebdavTest,
  type WebdavParams,
} from "../ipc";
import {
  deleteSecret,
  hostPasswordKey,
  keyPassphraseKey,
  keyPrivateKey,
  loadSecret,
  saveSecret,
  syncPassphraseKey,
  syncWebdavPasswordKey,
} from "../secrets";

// ---------- public reactive state ----------

export const syncEnabled = ref(false);
export const syncBusy = ref(false);
/** Local edits exist that haven't landed on the server yet (mirrors the
 *  mutationCount/pushedCount pending tracker for the status indicator). */
export const syncPending = ref(false);
export const lastSyncAt = ref<string | null>(null);
export const lastSyncError = ref<string | null>(null);
/** Bumped whenever applying remote changes touched the DB — host/key
 *  lists watch this to refresh. */
export const syncDataVersion = ref(0);

// ---------- document format ----------

const DOC_FORMAT = 1;

interface ForwardRec {
  kind: string;
  bind_host: string;
  bind_port: number;
  target_host: string | null;
  target_port: number | null;
  enabled: boolean;
}

interface KeyRec {
  label: string;
  public_key: string | null;
  has_passphrase: boolean;
  /** Secrets ride inside the (encrypted) document. */
  private_key: string | null;
  passphrase: string | null;
  created_at: string;
  updated_at: string;
}

interface GroupRec {
  label: string;
  /** Parent group's sync id (numeric ids don't survive across devices). */
  parent: string | null;
  hidden: boolean;
  created_at: string;
  updated_at: string;
}

interface HostRec {
  label: string;
  hostname: string;
  port: number;
  username: string;
  auth_method: string;
  /** Linked key's / group's sync id. */
  key: string | null;
  group: string | null;
  has_password: boolean;
  password: string | null;
  host_fp_sha256: string | null;
  host_key_alg: string | null;
  disable_sftp: boolean;
  disable_ssh: boolean;
  forwards: ForwardRec[];
  created_at: string;
  updated_at: string;
}

interface SyncDoc {
  format: number;
  keys: Record<string, KeyRec>;
  groups: Record<string, GroupRec>;
  hosts: Record<string, HostRec>;
  /** `"host:<sync_id>" | "key:…" | "group:…"` → deleted_at. */
  tombstones: Record<string, string>;
}

function emptyDoc(): SyncDoc {
  return { format: DOC_FORMAT, keys: {}, groups: {}, hosts: {}, tombstones: {} };
}

function parseDoc(json: string): SyncDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("remote sync document is not valid JSON");
  }
  const o = (raw ?? {}) as Partial<SyncDoc>;
  if (typeof o.format === "number" && o.format > DOC_FORMAT) {
    throw new Error(
      "the sync document was written by a newer version of Prmpt — update this install before syncing",
    );
  }
  return {
    format: DOC_FORMAT,
    keys: o.keys ?? {},
    groups: o.groups ?? {},
    hosts: o.hosts ?? {},
    tombstones: o.tombstones ?? {},
  };
}

/** Stable stringify (sorted object keys) so document comparison and the
 *  merge tie-break are deterministic on every device. */
function canon(v: unknown): string {
  return JSON.stringify(sortValue(v));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortValue(src[k]);
    return out;
  }
  return v ?? null;
}

// ---------- settings (sync_meta + Stronghold) ----------

export interface SyncSettingsForm {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
  passphrase: string;
  intervalMinutes: number;
}

const DEFAULT_INTERVAL_MIN = 5;

async function getMeta(key: string): Promise<string | null> {
  const rows = await dbHandle().select<{ value: string }[]>(
    `SELECT value FROM sync_meta WHERE key = $1`,
    [key],
  );
  return rows[0]?.value ?? null;
}

async function setMeta(key: string, value: string): Promise<void> {
  await dbHandle().execute(
    `INSERT OR REPLACE INTO sync_meta (key, value) VALUES ($1, $2)`,
    [key, value],
  );
}

export async function loadSyncSettings(): Promise<SyncSettingsForm> {
  const [enabled, url, username, interval, password, passphrase] = await Promise.all([
    getMeta("enabled"),
    getMeta("url"),
    getMeta("username"),
    getMeta("interval_minutes"),
    loadSecret(syncWebdavPasswordKey()).catch(() => null),
    loadSecret(syncPassphraseKey()).catch(() => null),
  ]);
  return {
    enabled: enabled === "1",
    url: url ?? "",
    username: username ?? "",
    password: password ?? "",
    passphrase: passphrase ?? "",
    intervalMinutes: Math.max(1, Number(interval) || DEFAULT_INTERVAL_MIN),
  };
}

export async function saveSyncSettings(form: SyncSettingsForm): Promise<void> {
  if (form.enabled && !form.url.trim()) {
    throw new Error("A WebDAV URL is required to enable sync.");
  }
  if (form.enabled && !form.passphrase) {
    // The document carries SSH passwords and private keys — the backend
    // also refuses to push without a passphrase (sync.rs).
    throw new Error("An encryption passphrase is required to enable sync.");
  }
  await setMeta("enabled", form.enabled ? "1" : "0");
  await setMeta("url", form.url.trim());
  await setMeta("username", form.username.trim());
  await setMeta("interval_minutes", String(Math.max(1, Math.round(form.intervalMinutes))));
  if (form.password) await saveSecret(syncWebdavPasswordKey(), form.password);
  else await deleteSecret(syncWebdavPasswordKey()).catch(() => undefined);
  if (form.passphrase) await saveSecret(syncPassphraseKey(), form.passphrase);
  else await deleteSecret(syncPassphraseKey()).catch(() => undefined);

  syncEnabled.value = form.enabled;
  intervalMinutes = Math.max(1, Math.round(form.intervalMinutes));
  restartScheduler();
  if (form.enabled) {
    noteLocalMutation(); // force a full pull+merge against the (possibly new) server
    // Awaited so the settings pane can report how the first sync went
    // (syncNow itself never throws — check `lastSyncError` after).
    await syncNow();
  }
}

/** Validate URL + credentials without touching any stored settings. */
export async function testSyncConnection(form: {
  url: string;
  username: string;
  password: string;
}): Promise<void> {
  await syncWebdavTest({
    url: form.url.trim(),
    username: form.username.trim(),
    password: form.password,
  });
}

// ---------- local snapshot ----------

interface LocalSnapshot {
  doc: SyncDoc;
  keyIdBySync: Map<string, number>;
  groupIdBySync: Map<string, number>;
  hostIdBySync: Map<string, number>;
}

/** Rows inserted by a pre-sync binary have no sync_id; give them one
 *  before they enter a document. */
async function backfillSyncIds(): Promise<void> {
  const db = dbHandle();
  for (const table of ["ssh_hosts", "ssh_keys", "ssh_groups"]) {
    const rows = await db.select<{ id: number }[]>(
      `SELECT id FROM ${table} WHERE sync_id IS NULL`,
    );
    for (const r of rows) {
      await db.execute(`UPDATE ${table} SET sync_id = $1 WHERE id = $2`, [
        crypto.randomUUID(),
        r.id,
      ]);
    }
  }
}

async function buildLocalSnapshot(): Promise<LocalSnapshot> {
  await backfillSyncIds();
  const db = dbHandle();
  const doc = emptyDoc();
  const keyIdBySync = new Map<string, number>();
  const groupIdBySync = new Map<string, number>();
  const hostIdBySync = new Map<string, number>();

  const keyRows = await db.select<
    {
      id: number;
      label: string;
      has_passphrase: number;
      public_key: string | null;
      sync_id: string;
      created_at: string;
      updated_at: string;
    }[]
  >(`SELECT id, label, has_passphrase, public_key, sync_id, created_at, updated_at FROM ssh_keys`);
  const keySyncById = new Map<number, string>();
  for (const r of keyRows) {
    keyIdBySync.set(r.sync_id, r.id);
    keySyncById.set(r.id, r.sync_id);
    doc.keys[r.sync_id] = {
      label: r.label,
      public_key: r.public_key,
      has_passphrase: !!r.has_passphrase,
      private_key: await loadSecret(keyPrivateKey(r.id)),
      passphrase: await loadSecret(keyPassphraseKey(r.id)),
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  const groupRows = await db.select<
    {
      id: number;
      label: string;
      parent_id: number | null;
      hidden: number;
      sync_id: string;
      created_at: string;
      updated_at: string;
    }[]
  >(`SELECT id, label, parent_id, hidden, sync_id, created_at, updated_at FROM ssh_groups`);
  const groupSyncById = new Map<number, string>();
  for (const r of groupRows) {
    groupIdBySync.set(r.sync_id, r.id);
    groupSyncById.set(r.id, r.sync_id);
  }
  for (const r of groupRows) {
    doc.groups[r.sync_id] = {
      label: r.label,
      parent: r.parent_id != null ? (groupSyncById.get(r.parent_id) ?? null) : null,
      hidden: !!r.hidden,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  const fwdRows = await db.select<
    {
      host_id: number;
      kind: string;
      bind_host: string;
      bind_port: number;
      target_host: string | null;
      target_port: number | null;
      enabled: number;
    }[]
  >(
    `SELECT host_id, kind, bind_host, bind_port, target_host, target_port, enabled
     FROM ssh_port_forwards ORDER BY id`,
  );
  const fwdsByHost = new Map<number, ForwardRec[]>();
  for (const f of fwdRows) {
    const list = fwdsByHost.get(f.host_id) ?? [];
    list.push({
      kind: f.kind,
      bind_host: f.bind_host,
      bind_port: f.bind_port,
      target_host: f.target_host,
      target_port: f.target_port,
      enabled: !!f.enabled,
    });
    fwdsByHost.set(f.host_id, list);
  }

  const hostRows = await db.select<
    {
      id: number;
      label: string;
      hostname: string;
      port: number;
      username: string;
      auth_method: string;
      has_password: number;
      key_id: number | null;
      group_id: number | null;
      host_fp_sha256: string | null;
      host_key_alg: string | null;
      disable_sftp: number;
      disable_ssh: number;
      sync_id: string;
      created_at: string;
      updated_at: string;
    }[]
  >(
    `SELECT id, label, hostname, port, username, auth_method, has_password, key_id,
            group_id, host_fp_sha256, host_key_alg, disable_sftp, disable_ssh,
            sync_id, created_at, updated_at
     FROM ssh_hosts`,
  );
  for (const r of hostRows) {
    hostIdBySync.set(r.sync_id, r.id);
    doc.hosts[r.sync_id] = {
      label: r.label,
      hostname: r.hostname,
      port: r.port,
      username: r.username,
      auth_method: r.auth_method,
      key: r.key_id != null ? (keySyncById.get(r.key_id) ?? null) : null,
      group: r.group_id != null ? (groupSyncById.get(r.group_id) ?? null) : null,
      has_password: !!r.has_password,
      password: r.has_password ? await loadSecret(hostPasswordKey(r.id)) : null,
      host_fp_sha256: r.host_fp_sha256,
      host_key_alg: r.host_key_alg,
      disable_sftp: !!r.disable_sftp,
      disable_ssh: !!r.disable_ssh,
      forwards: fwdsByHost.get(r.id) ?? [],
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  const tombRows = await db.select<{ kind: string; sync_id: string; deleted_at: string }[]>(
    `SELECT kind, sync_id, deleted_at FROM sync_tombstones`,
  );
  for (const t of tombRows) doc.tombstones[`${t.kind}:${t.sync_id}`] = t.deleted_at;

  return { doc, keyIdBySync, groupIdBySync, hostIdBySync };
}

// ---------- merge ----------

type Kind = "key" | "group" | "host";
const KINDS: Kind[] = ["key", "group", "host"];

function recsOf(doc: SyncDoc, kind: Kind): Record<string, { updated_at: string }> {
  return kind === "key" ? doc.keys : kind === "group" ? doc.groups : doc.hosts;
}

/** Newer `updated_at` wins; on an exact tie the canonically-larger record
 *  wins so every device resolves the tie identically (no ping-pong). */
function pickRecord<T extends { updated_at: string }>(a: T, b: T): T {
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? a : b;
  return canon(a) >= canon(b) ? a : b;
}

function mergeDocs(local: SyncDoc, remote: SyncDoc): SyncDoc {
  const merged = emptyDoc();
  for (const kind of KINDS) {
    const l = recsOf(local, kind);
    const r = recsOf(remote, kind);
    const ids = new Set<string>([...Object.keys(l), ...Object.keys(r)]);
    for (const key of Object.keys(local.tombstones).concat(Object.keys(remote.tombstones))) {
      if (key.startsWith(`${kind}:`)) ids.add(key.slice(kind.length + 1));
    }
    for (const id of ids) {
      const tombKey = `${kind}:${id}`;
      const lRec = l[id];
      const rRec = r[id];
      const rec = lRec && rRec ? pickRecord(lRec, rRec) : (lRec ?? rRec ?? null);
      const lTomb = local.tombstones[tombKey];
      const rTomb = remote.tombstones[tombKey];
      const tomb =
        lTomb && rTomb ? (lTomb > rTomb ? lTomb : rTomb) : (lTomb ?? rTomb ?? null);
      // A record edited at/after its deletion resurrects (ties keep data);
      // the losing tombstone is dropped so it can't win a later merge.
      if (rec && (!tomb || rec.updated_at >= tomb)) {
        recsOf(merged, kind)[id] = rec;
      } else if (tomb) {
        merged.tombstones[tombKey] = tomb;
      }
    }
  }
  return merged;
}

/** Concurrent re-parenting on two devices can merge into a parent cycle;
 *  detach any group whose parent chain loops (GroupTree would spin). */
function breakGroupCycles(doc: SyncDoc): void {
  for (const id of Object.keys(doc.groups)) {
    const seen = new Set<string>([id]);
    let cur = doc.groups[id].parent;
    while (cur) {
      if (seen.has(cur)) {
        doc.groups[id] = { ...doc.groups[id], parent: null };
        break;
      }
      seen.add(cur);
      cur = doc.groups[cur]?.parent ?? null;
    }
  }
}

// ---------- apply ----------

/** Write everything the merged document changed into the local DB and
 *  Stronghold. All writes go through `dbHandle()` directly — remote
 *  timestamps and sync ids are preserved verbatim, and the db.ts mutation
 *  hook (which would schedule another push) never fires. Returns whether
 *  anything local actually changed. */
async function applyMerged(merged: SyncDoc, snap: LocalSnapshot): Promise<boolean> {
  const db = dbHandle();
  let changed = false;

  // -- deletions (rows whose tombstone won) --
  // Deleted ids are also dropped from the sync→local id maps so a merged
  // record that (through a lost concurrent edit) still references the
  // tombstoned row resolves to NULL rather than a dangling local id.
  for (const [id, hostId] of [...snap.hostIdBySync]) {
    if (merged.hosts[id]) continue;
    await db.execute(`DELETE FROM ssh_port_forwards WHERE host_id = $1`, [hostId]);
    await db.execute(`DELETE FROM ssh_hosts WHERE id = $1`, [hostId]);
    await deleteSecret(hostPasswordKey(hostId)).catch(() => undefined);
    snap.hostIdBySync.delete(id);
    changed = true;
  }
  for (const [id, keyId] of [...snap.keyIdBySync]) {
    if (merged.keys[id]) continue;
    await db.execute(`UPDATE ssh_hosts SET key_id = NULL WHERE key_id = $1`, [keyId]);
    await db.execute(`DELETE FROM ssh_keys WHERE id = $1`, [keyId]);
    await deleteSecret(keyPrivateKey(keyId)).catch(() => undefined);
    await deleteSecret(keyPassphraseKey(keyId)).catch(() => undefined);
    snap.keyIdBySync.delete(id);
    changed = true;
  }
  for (const [id, groupId] of [...snap.groupIdBySync]) {
    if (merged.groups[id]) continue;
    // Surviving members were reparented by the merged records themselves;
    // fall back to detaching anything still pointing here.
    await db.execute(`UPDATE ssh_groups SET parent_id = NULL WHERE parent_id = $1`, [groupId]);
    await db.execute(`UPDATE ssh_hosts SET group_id = NULL WHERE group_id = $1`, [groupId]);
    await db.execute(`DELETE FROM ssh_groups WHERE id = $1`, [groupId]);
    snap.groupIdBySync.delete(id);
    changed = true;
  }

  // -- keys --
  const keyIds = new Map(snap.keyIdBySync);
  for (const [id, rec] of Object.entries(merged.keys)) {
    const local = snap.doc.keys[id];
    if (local && canon(local) === canon(rec)) continue;
    // A synced key without its private-key secret is unusable until
    // re-entered — same "broken" semantics as a quarantined snapshot.
    const broken = rec.private_key == null ? 1 : 0;
    let keyId = keyIds.get(id);
    if (keyId == null) {
      const res = await db.execute(
        `INSERT INTO ssh_keys (label, has_passphrase, public_key, broken, sync_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [rec.label, rec.has_passphrase ? 1 : 0, rec.public_key, broken, id, rec.created_at, rec.updated_at],
      );
      keyId = res.lastInsertId ?? 0;
      keyIds.set(id, keyId);
    } else {
      await db.execute(
        `UPDATE ssh_keys SET label = $1, has_passphrase = $2, public_key = $3,
                broken = $4, created_at = $5, updated_at = $6
         WHERE id = $7`,
        [rec.label, rec.has_passphrase ? 1 : 0, rec.public_key, broken, rec.created_at, rec.updated_at, keyId],
      );
    }
    if ((local?.private_key ?? null) !== rec.private_key) {
      if (rec.private_key != null) await saveSecret(keyPrivateKey(keyId), rec.private_key);
      else await deleteSecret(keyPrivateKey(keyId)).catch(() => undefined);
    }
    if ((local?.passphrase ?? null) !== rec.passphrase) {
      if (rec.passphrase != null) await saveSecret(keyPassphraseKey(keyId), rec.passphrase);
      else await deleteSecret(keyPassphraseKey(keyId)).catch(() => undefined);
    }
    changed = true;
  }

  // -- groups (two passes: rows first, parent links after every group has
  //    a local id — a child can arrive before its parent) --
  const groupIds = new Map(snap.groupIdBySync);
  for (const [id, rec] of Object.entries(merged.groups)) {
    const local = snap.doc.groups[id];
    if (local && canon(local) === canon(rec)) continue;
    const groupId = groupIds.get(id);
    if (groupId == null) {
      const res = await db.execute(
        `INSERT INTO ssh_groups (label, parent_id, open, hidden, sync_id, created_at, updated_at)
         VALUES ($1, NULL, 0, $2, $3, $4, $5)`,
        [rec.label, rec.hidden ? 1 : 0, id, rec.created_at, rec.updated_at],
      );
      groupIds.set(id, res.lastInsertId ?? 0);
    } else {
      // `open` is untouched: expanded/collapsed is per-device UI state.
      await db.execute(
        `UPDATE ssh_groups SET label = $1, hidden = $2, created_at = $3, updated_at = $4
         WHERE id = $5`,
        [rec.label, rec.hidden ? 1 : 0, rec.created_at, rec.updated_at, groupId],
      );
    }
    changed = true;
  }
  for (const [id, rec] of Object.entries(merged.groups)) {
    const local = snap.doc.groups[id];
    if (local && canon(local) === canon(rec)) continue;
    const parentId = rec.parent != null ? (groupIds.get(rec.parent) ?? null) : null;
    await db.execute(`UPDATE ssh_groups SET parent_id = $1 WHERE id = $2`, [
      parentId,
      groupIds.get(id),
    ]);
  }

  // -- hosts --
  const hostIds = new Map(snap.hostIdBySync);
  for (const [id, rec] of Object.entries(merged.hosts)) {
    const local = snap.doc.hosts[id];
    if (local && canon(local) === canon(rec)) continue;
    const keyId = rec.key != null ? (keyIds.get(rec.key) ?? null) : null;
    const groupId = rec.group != null ? (groupIds.get(rec.group) ?? null) : null;
    const broken =
      rec.auth_method === "password" && rec.has_password && rec.password == null ? 1 : 0;
    let hostId = hostIds.get(id);
    if (hostId == null) {
      const res = await db.execute(
        `INSERT INTO ssh_hosts
           (label, hostname, port, username, auth_method, has_password, key_id, group_id,
            host_fp_sha256, host_key_alg, disable_sftp, disable_ssh, broken, sync_id,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          rec.label,
          rec.hostname,
          rec.port,
          rec.username,
          rec.auth_method,
          rec.has_password ? 1 : 0,
          keyId,
          groupId,
          rec.host_fp_sha256,
          rec.host_key_alg,
          rec.disable_sftp ? 1 : 0,
          rec.disable_ssh ? 1 : 0,
          broken,
          id,
          rec.created_at,
          rec.updated_at,
        ],
      );
      hostId = res.lastInsertId ?? 0;
      hostIds.set(id, hostId);
    } else {
      await db.execute(
        `UPDATE ssh_hosts
           SET label = $1, hostname = $2, port = $3, username = $4, auth_method = $5,
               has_password = $6, key_id = $7, group_id = $8, host_fp_sha256 = $9,
               host_key_alg = $10, disable_sftp = $11, disable_ssh = $12, broken = $13,
               created_at = $14, updated_at = $15
         WHERE id = $16`,
        [
          rec.label,
          rec.hostname,
          rec.port,
          rec.username,
          rec.auth_method,
          rec.has_password ? 1 : 0,
          keyId,
          groupId,
          rec.host_fp_sha256,
          rec.host_key_alg,
          rec.disable_sftp ? 1 : 0,
          rec.disable_ssh ? 1 : 0,
          broken,
          rec.created_at,
          rec.updated_at,
          hostId,
        ],
      );
    }
    if (!local || canon(local.forwards) !== canon(rec.forwards)) {
      await db.execute(`DELETE FROM ssh_port_forwards WHERE host_id = $1`, [hostId]);
      const now = new Date().toISOString();
      for (const f of rec.forwards) {
        await db.execute(
          `INSERT INTO ssh_port_forwards
             (host_id, kind, bind_host, bind_port, target_host, target_port, enabled, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [hostId, f.kind, f.bind_host, f.bind_port, f.target_host, f.target_port, f.enabled ? 1 : 0, now],
        );
      }
    }
    if ((local?.password ?? null) !== rec.password) {
      if (rec.password != null) await saveSecret(hostPasswordKey(hostId), rec.password);
      else await deleteSecret(hostPasswordKey(hostId)).catch(() => undefined);
    }
    changed = true;
  }

  // -- tombstone table mirrors the merged document --
  if (canon(snap.doc.tombstones) !== canon(merged.tombstones)) {
    await db.execute(`DELETE FROM sync_tombstones`);
    for (const [key, deletedAt] of Object.entries(merged.tombstones)) {
      const sep = key.indexOf(":");
      await db.execute(
        `INSERT OR REPLACE INTO sync_tombstones (kind, sync_id, deleted_at) VALUES ($1, $2, $3)`,
        [key.slice(0, sep), key.slice(sep + 1), deletedAt],
      );
    }
    changed = true;
  }

  return changed;
}

// ---------- the sync cycle ----------

/** Local-edit bookkeeping, counter-based so nothing gets stranded offline:
 *  the mutation hook bumps `mutationCount`; a cycle records the count its
 *  snapshot was built at and promotes it to `pushedCount` only when the
 *  whole cycle (including the push) succeeded. A failed push — server
 *  down, mid-flight network drop — therefore leaves the edits pending,
 *  and the retry/interval/focus triggers keep re-attempting until they
 *  land. Edits arriving *during* a cycle stay above `pushedCount` too and
 *  get their own follow-up cycle. */
let mutationCount = 1; // starts above pushedCount: the boot sync is a full cycle
let pushedCount = 0;
let syncing = false;
let runAgain = false;

function noteLocalMutation(): void {
  mutationCount++;
  syncPending.value = true;
}

function errString(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export async function syncNow(): Promise<void> {
  if (syncing) {
    runAgain = true;
    return;
  }
  syncing = true;
  syncBusy.value = true;
  try {
    const s = await loadSyncSettings();
    // Re-read from the DB (not this window's ref): settings may have been
    // saved in another window, and every window shares the same DB.
    syncEnabled.value = s.enabled;
    intervalMinutes = s.intervalMinutes;
    if (!s.enabled) return;
    if (!s.url.trim()) throw new Error("no WebDAV URL configured");
    if (!s.passphrase) throw new Error("no encryption passphrase configured");
    const params: WebdavParams = {
      url: s.url,
      username: s.username,
      password: s.password,
    };

    // Up to 3 attempts: a 412 on push means another device won the race —
    // pull its revision, merge again, push again.
    let forceFullPull = false;
    for (let attempt = 0; ; attempt++) {
      const snapCount = mutationCount;
      const hasPending = snapCount > pushedCount;
      const cachedEtag = hasPending || forceFullPull ? null : await getMeta("last_etag");
      const pull = await syncWebdavPull(params, s.passphrase, cachedEtag || null);
      if (pull.not_modified) break; // remote unchanged, nothing local pending

      const remote = pull.data ? parseDoc(pull.data) : emptyDoc();
      const snap = await buildLocalSnapshot();
      const merged = mergeDocs(snap.doc, remote);
      breakGroupCycles(merged);

      if (await applyMerged(merged, snap)) syncDataVersion.value++;

      if (canon(merged) !== canon(remote) || pull.data == null) {
        try {
          const newTag = await syncWebdavPush(params, s.passphrase, canon(merged), pull.etag);
          await setMeta("last_etag", newTag ?? "");
        } catch (e) {
          if (errString(e).includes(SYNC_CONFLICT) && attempt < 2) {
            forceFullPull = true; // the retry must pull the winning revision
            continue;
          }
          throw e;
        }
      } else {
        await setMeta("last_etag", pull.etag ?? "");
      }
      // Everything up to the snapshot is on the server now. Edits made
      // while this cycle ran are still > pushedCount and re-trigger.
      pushedCount = Math.max(pushedCount, snapCount);
      break;
    }

    const now = new Date().toISOString();
    lastSyncAt.value = now;
    lastSyncError.value = null;
    syncPending.value = mutationCount > pushedCount;
    resetRetry();
    await setMeta("last_sync_at", now);
  } catch (e) {
    lastSyncError.value = errString(e);
    console.error("[sync] failed:", e);
    scheduleRetry();
  } finally {
    syncing = false;
    syncBusy.value = false;
    if (runAgain) {
      runAgain = false;
      scheduleDebounced();
    }
  }
}

// ---------- scheduling ----------

const DEBOUNCE_MS = 2_000;
const FOCUS_THROTTLE_MS = 5_000;
const RETRY_MIN_MS = 15_000;
const RETRY_MAX_MS = 5 * 60_000;

let intervalMinutes = DEFAULT_INTERVAL_MIN;
let intervalTimer: number | undefined;
let debounceTimer: number | undefined;
let retryTimer: number | undefined;
let retryDelayMs = RETRY_MIN_MS;
let lastAttemptAt = 0;

function scheduleDebounced(): void {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    lastAttemptAt = Date.now();
    void syncNow();
  }, DEBOUNCE_MS);
}

/** After a failed cycle: retry with exponential backoff (15 s → 5 min cap)
 *  regardless of window focus. This — not the unreliable `online` event —
 *  is what guarantees offline edits eventually push: the app can be edited
 *  freely while unreachable, and pending changes land on the first retry
 *  that gets through. */
function scheduleRetry(): void {
  if (!syncEnabled.value) return;
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    lastAttemptAt = Date.now();
    void syncNow();
  }, retryDelayMs);
  retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
}

function resetRetry(): void {
  window.clearTimeout(retryTimer);
  retryTimer = undefined;
  retryDelayMs = RETRY_MIN_MS;
}

function restartScheduler(): void {
  window.clearInterval(intervalTimer);
  intervalTimer = undefined;
  if (!syncEnabled.value) {
    resetRetry();
    return;
  }
  intervalTimer = window.setInterval(() => {
    // Only the focused window polls — otherwise every open window (and the
    // hidden reserve-pool windows) would hit the server in lockstep.
    if (!document.hasFocus()) return;
    lastAttemptAt = Date.now();
    void syncNow();
  }, intervalMinutes * 60_000);
}

/** Wire up the engine for this window. Called once from main.ts after the
 *  DB is open. Every window registers the mutation hook (edits happen in
 *  whichever window the user is typing in) and a focus trigger; only the
 *  initial "main" window runs the startup sync, so the reserve-window pool
 *  doesn't multiply boot traffic. */
export async function initSync(): Promise<void> {
  try {
    const s = await loadSyncSettings();
    syncEnabled.value = s.enabled;
    intervalMinutes = s.intervalMinutes;
    lastSyncAt.value = await getMeta("last_sync_at");
  } catch (e) {
    console.error("[sync] init failed:", e);
    return;
  }

  // Schedule unconditionally: syncNow re-checks the enabled flag from the
  // DB, so an edit in this window syncs even when sync was switched on
  // from a different window (this window's ref would still be stale).
  setDbMutationListener(() => {
    noteLocalMutation();
    scheduleDebounced();
  });

  window.addEventListener("focus", () => {
    if (!syncEnabled.value) return;
    if (Date.now() - lastAttemptAt < FOCUS_THROTTLE_MS) return;
    lastAttemptAt = Date.now();
    void syncNow();
  });

  // Best-effort extra trigger when connectivity returns. Unreliable on
  // WebKit (macOS/iOS may never fire it / report online while offline —
  // WebKit bugs 225645, 171277), so the retry backoff above remains the
  // real recovery path; on WebView2 this makes reconnects near-instant.
  window.addEventListener("online", () => {
    if (!syncEnabled.value) return;
    lastAttemptAt = Date.now();
    void syncNow();
  });

  restartScheduler();
  if (syncEnabled.value && currentWindowLabel() === "main") {
    lastAttemptAt = Date.now();
    void syncNow();
  }
}
