/**
 * Database layer — talks to the tauri-plugin-sql `Database` directly
 * from JS. The Rust side just registers the migrations; everything
 * else (host/key/port-forward CRUD, broken-flag bookkeeping) lives
 * here.
 *
 * Initialize once at app startup with `openDb()` before using any
 * of the CRUD helpers.
 */

import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";

export type SshAuthMethod = "password" | "key" | "agent";
export type SshForwardKind = "local" | "remote" | "dynamic";

export interface SshHostRow {
  id: number;
  label: string;
  hostname: string;
  port: number;
  username: string;
  auth_method: SshAuthMethod;
  has_password: boolean;
  key_id: number | null;
  key_label: string | null;
  host_fp_sha256: string | null;
  host_key_alg: string | null;
  group_id: number | null;
  broken: boolean;
  /** Per-host opt-out for the SFTP file browser panel. */
  disable_sftp: boolean;
  /** Per-host opt-in for SFTP-only connections (no shell channel). */
  disable_ssh: boolean;
  created_at: string;
  updated_at: string;
}

export interface SshGroupRow {
  id: number;
  label: string;
  parent_id: number | null;
  open: boolean;
  hidden: boolean;
  created_at: string;
  updated_at: string;
}

export interface SshGroupInput {
  id?: number | null;
  label: string;
  parent_id?: number | null;
}

export interface SshKeyRow {
  id: number;
  label: string;
  has_passphrase: boolean;
  public_key: string | null;
  broken: boolean;
  created_at: string;
  updated_at: string;
}

export interface SshPortForwardRow {
  id: number | null;
  host_id: number;
  kind: SshForwardKind;
  bind_host: string;
  bind_port: number;
  target_host: string | null;
  target_port: number | null;
  enabled: boolean;
}

export interface SshHostInput {
  id?: number | null;
  label: string;
  hostname: string;
  port: number;
  username: string;
  auth_method: SshAuthMethod;
  key_id?: number | null;
  group_id?: number | null;
  /** Mark `has_password` and clear `broken` if `true`. The actual
   *  password bytes live in Stronghold; we just bookkeep the flag. */
  has_password: boolean;
  /** Per-host opt-out for the SFTP file browser panel. */
  disable_sftp: boolean;
  /** Per-host opt-in for SFTP-only connections (no shell channel). */
  disable_ssh: boolean;
}

export interface SshKeyInput {
  id?: number | null;
  label: string;
  public_key?: string | null;
  has_passphrase: boolean;
}

/** Raw row shape coming back from `db.select` — booleans arrive as
 *  0/1 integers, all other columns are typed as-is. */
type RawHostRow = Omit<
  SshHostRow,
  "has_password" | "broken" | "disable_sftp" | "disable_ssh"
> & {
  has_password: number;
  broken: number;
  disable_sftp: number;
  disable_ssh: number;
};

type RawKeyRow = Omit<SshKeyRow, "has_passphrase" | "broken"> & {
  has_passphrase: number;
  broken: number;
};

type RawForwardRow = Omit<SshPortForwardRow, "enabled"> & { enabled: number };

type RawGroupRow = Omit<SshGroupRow, "open" | "hidden"> & {
  open: number;
  hidden: number;
};

let db: Database | null = null;

/** Opens (and migrates) the database. Idempotent. The connection URL
 *  is resolved by the backend (`get_db_url`) so JS and Rust agree on
 *  the absolute path the SQL plugin registered migrations under. */
export async function openDb(): Promise<Database> {
  if (!db) {
    const url = await invoke<string>("get_db_url");
    db = await Database.load(url);
  }
  return db;
}

function ensure(): Database {
  if (!db) throw new Error("db not initialized — call openDb() at startup");
  return db;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------- hosts ----------

export async function listHosts(): Promise<SshHostRow[]> {
  const rows = await ensure().select<RawHostRow[]>(
    `SELECT h.id, h.label, h.hostname, h.port, h.username, h.auth_method,
            h.has_password, h.key_id, k.label AS key_label,
            h.host_fp_sha256, h.host_key_alg, h.group_id, h.broken,
            h.disable_sftp, h.disable_ssh, h.created_at, h.updated_at
     FROM ssh_hosts h
     LEFT JOIN ssh_keys k ON k.id = h.key_id
     ORDER BY h.label COLLATE NOCASE`,
  );
  return rows.map(hostFromRow);
}

export async function getHost(id: number): Promise<SshHostRow | null> {
  const rows = await ensure().select<RawHostRow[]>(
    `SELECT h.id, h.label, h.hostname, h.port, h.username, h.auth_method,
            h.has_password, h.key_id, k.label AS key_label,
            h.host_fp_sha256, h.host_key_alg, h.group_id, h.broken,
            h.disable_sftp, h.disable_ssh, h.created_at, h.updated_at
     FROM ssh_hosts h
     LEFT JOIN ssh_keys k ON k.id = h.key_id
     WHERE h.id = $1`,
    [id],
  );
  return rows[0] ? hostFromRow(rows[0]) : null;
}

function hostFromRow(r: RawHostRow): SshHostRow {
  return {
    ...r,
    has_password: !!r.has_password,
    broken: !!r.broken,
    disable_sftp: !!r.disable_sftp,
    disable_ssh: !!r.disable_ssh,
  };
}

export async function saveHost(input: SshHostInput): Promise<number> {
  const now = nowIso();
  if (input.id == null) {
    const res = await ensure().execute(
      `INSERT INTO ssh_hosts
         (label, hostname, port, username, auth_method,
          has_password, key_id, group_id, disable_sftp, disable_ssh,
          broken, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12)`,
      [
        input.label,
        input.hostname,
        input.port,
        input.username,
        input.auth_method,
        input.has_password ? 1 : 0,
        input.key_id ?? null,
        input.group_id ?? null,
        input.disable_sftp ? 1 : 0,
        input.disable_ssh ? 1 : 0,
        now,
        now,
      ],
    );
    return res.lastInsertId ?? 0;
  }
  await ensure().execute(
    `UPDATE ssh_hosts
       SET label = $1, hostname = $2, port = $3, username = $4,
           auth_method = $5, has_password = $6, key_id = $7,
           group_id = $8, disable_sftp = $9, disable_ssh = $10,
           broken = 0, updated_at = $11
     WHERE id = $12`,
    [
      input.label,
      input.hostname,
      input.port,
      input.username,
      input.auth_method,
      input.has_password ? 1 : 0,
      input.key_id ?? null,
      input.group_id ?? null,
      input.disable_sftp ? 1 : 0,
      input.disable_ssh ? 1 : 0,
      now,
      input.id,
    ],
  );
  return input.id;
}

/** Create a copy of an existing host (new row + copied port forwards) and
 *  return its id. The label gets a " (copy)" suffix. The stored password
 *  secret is NOT copied here — it lives in Stronghold and is handled by the
 *  caller (the `has_password` flag is carried over so the caller knows whether
 *  to duplicate the secret). The host-key fingerprint is intentionally left
 *  unset so the copy re-runs TOFU on first connect. */
export async function duplicateHost(source: SshHostRow): Promise<number> {
  const newId = await saveHost({
    id: null,
    label: `${source.label} (copy)`,
    hostname: source.hostname,
    port: source.port,
    username: source.username,
    auth_method: source.auth_method,
    key_id: source.key_id,
    group_id: source.group_id,
    has_password: source.has_password,
    disable_sftp: source.disable_sftp,
    disable_ssh: source.disable_ssh,
  });
  const forwards = await listPortForwards(source.id);
  for (const f of forwards) {
    await savePortForward({ ...f, id: null, host_id: newId });
  }
  return newId;
}

export async function clearHostPasswordFlag(id: number): Promise<void> {
  await ensure().execute(
    `UPDATE ssh_hosts SET has_password = 0, broken = 0, updated_at = $1 WHERE id = $2`,
    [nowIso(), id],
  );
}

export async function markHostHasPassword(id: number, value: boolean): Promise<void> {
  await ensure().execute(
    `UPDATE ssh_hosts SET has_password = $1, broken = 0, updated_at = $2 WHERE id = $3`,
    [value ? 1 : 0, nowIso(), id],
  );
}

export async function deleteHost(id: number): Promise<void> {
  await ensure().execute(`DELETE FROM ssh_port_forwards WHERE host_id = $1`, [id]);
  await ensure().execute(`DELETE FROM ssh_hosts WHERE id = $1`, [id]);
}

export async function recordHostFingerprint(
  id: number,
  fingerprint: string,
  algorithm: string,
): Promise<void> {
  await ensure().execute(
    `UPDATE ssh_hosts SET host_fp_sha256 = $1, host_key_alg = $2, updated_at = $3 WHERE id = $4`,
    [fingerprint, algorithm, nowIso(), id],
  );
}

export async function resetHostFingerprint(id: number): Promise<void> {
  await ensure().execute(
    `UPDATE ssh_hosts SET host_fp_sha256 = NULL, host_key_alg = NULL, updated_at = $1 WHERE id = $2`,
    [nowIso(), id],
  );
}

// ---------- groups ----------

function groupFromRow(r: RawGroupRow): SshGroupRow {
  return { ...r, open: !!r.open, hidden: !!r.hidden };
}

export async function listGroups(): Promise<SshGroupRow[]> {
  const rows = await ensure().select<RawGroupRow[]>(
    `SELECT id, label, parent_id, open, hidden, created_at, updated_at
     FROM ssh_groups ORDER BY label COLLATE NOCASE`,
  );
  return rows.map(groupFromRow);
}

/** Persist a group's expanded/collapsed state in the sidebar tree. */
export async function setGroupOpen(id: number, open: boolean): Promise<void> {
  await ensure().execute(`UPDATE ssh_groups SET open = $1 WHERE id = $2`, [
    open ? 1 : 0,
    id,
  ]);
}

/** Toggle whether a group (and its subtree) is concealed behind the PIN lock. */
export async function setGroupHidden(id: number, hidden: boolean): Promise<void> {
  await ensure().execute(`UPDATE ssh_groups SET hidden = $1, updated_at = $2 WHERE id = $3`, [
    hidden ? 1 : 0,
    nowIso(),
    id,
  ]);
}

export async function saveGroup(input: SshGroupInput): Promise<number> {
  const now = nowIso();
  if (input.id == null) {
    const res = await ensure().execute(
      `INSERT INTO ssh_groups (label, parent_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4)`,
      [input.label, input.parent_id ?? null, now, now],
    );
    return res.lastInsertId ?? 0;
  }
  await ensure().execute(
    `UPDATE ssh_groups SET label = $1, parent_id = $2, updated_at = $3 WHERE id = $4`,
    [input.label, input.parent_id ?? null, now, input.id],
  );
  return input.id;
}

/** Delete a group, reparenting its hosts and subgroups up one level.
 *  The FK ON DELETE clauses are inert (PRAGMA foreign_keys is OFF), so the
 *  cascade is done manually here — same pattern as `deleteKey`. Child
 *  subgroups inherit this group's parent (NULL → top level) and member
 *  hosts move to that parent too (NULL → ungrouped). Nothing is destroyed. */
export async function deleteGroup(id: number): Promise<void> {
  const rows = await ensure().select<{ parent_id: number | null }[]>(
    `SELECT parent_id FROM ssh_groups WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return;
  const parent = rows[0].parent_id;
  const now = nowIso();
  await ensure().execute(
    `UPDATE ssh_groups SET parent_id = $1, updated_at = $2 WHERE parent_id = $3`,
    [parent, now, id],
  );
  await ensure().execute(
    `UPDATE ssh_hosts SET group_id = $1, updated_at = $2 WHERE group_id = $3`,
    [parent, now, id],
  );
  await ensure().execute(`DELETE FROM ssh_groups WHERE id = $1`, [id]);
}

// ---------- keys ----------

export async function listKeys(): Promise<SshKeyRow[]> {
  const rows = await ensure().select<RawKeyRow[]>(
    `SELECT id, label, has_passphrase, public_key, broken, created_at, updated_at
     FROM ssh_keys ORDER BY label COLLATE NOCASE`,
  );
  return rows.map(keyFromRow);
}

export async function getKey(id: number): Promise<SshKeyRow | null> {
  const rows = await ensure().select<RawKeyRow[]>(
    `SELECT id, label, has_passphrase, public_key, broken, created_at, updated_at
     FROM ssh_keys WHERE id = $1`,
    [id],
  );
  return rows[0] ? keyFromRow(rows[0]) : null;
}

export async function markKeyHasPassphrase(id: number, value: boolean): Promise<void> {
  await ensure().execute(
    `UPDATE ssh_keys SET has_passphrase = $1, broken = 0, updated_at = $2 WHERE id = $3`,
    [value ? 1 : 0, nowIso(), id],
  );
}

function keyFromRow(r: RawKeyRow): SshKeyRow {
  return { ...r, has_passphrase: !!r.has_passphrase, broken: !!r.broken };
}

export async function saveKey(input: SshKeyInput): Promise<number> {
  const now = nowIso();
  if (input.id == null) {
    const res = await ensure().execute(
      `INSERT INTO ssh_keys (label, has_passphrase, public_key, broken, created_at, updated_at)
       VALUES ($1, $2, $3, 0, $4, $5)`,
      [input.label, input.has_passphrase ? 1 : 0, input.public_key ?? null, now, now],
    );
    return res.lastInsertId ?? 0;
  }
  await ensure().execute(
    `UPDATE ssh_keys
       SET label = $1, has_passphrase = $2, public_key = $3,
           broken = 0, updated_at = $4
     WHERE id = $5`,
    [input.label, input.has_passphrase ? 1 : 0, input.public_key ?? null, now, input.id],
  );
  return input.id;
}

export async function deleteKey(id: number): Promise<void> {
  // Manually unlink hosts — the FK ON DELETE SET NULL only fires when
  // PRAGMA foreign_keys = ON, which the SQL plugin doesn't enable.
  await ensure().execute(`UPDATE ssh_hosts SET key_id = NULL WHERE key_id = $1`, [id]);
  await ensure().execute(`DELETE FROM ssh_keys WHERE id = $1`, [id]);
}

// ---------- port forwards ----------

export async function listPortForwards(hostId: number): Promise<SshPortForwardRow[]> {
  const rows = await ensure().select<RawForwardRow[]>(
    `SELECT id, host_id, kind, bind_host, bind_port, target_host, target_port, enabled
     FROM ssh_port_forwards WHERE host_id = $1 ORDER BY id`,
    [hostId],
  );
  return rows.map((r) => ({ ...r, enabled: !!r.enabled }));
}

export async function savePortForward(fw: SshPortForwardRow): Promise<number> {
  const now = nowIso();
  if (fw.id == null) {
    const res = await ensure().execute(
      `INSERT INTO ssh_port_forwards
         (host_id, kind, bind_host, bind_port, target_host, target_port, enabled, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        fw.host_id,
        fw.kind,
        fw.bind_host,
        fw.bind_port,
        fw.target_host,
        fw.target_port,
        fw.enabled ? 1 : 0,
        now,
      ],
    );
    return res.lastInsertId ?? 0;
  }
  await ensure().execute(
    `UPDATE ssh_port_forwards
       SET kind = $1, bind_host = $2, bind_port = $3,
           target_host = $4, target_port = $5, enabled = $6
     WHERE id = $7`,
    [
      fw.kind,
      fw.bind_host,
      fw.bind_port,
      fw.target_host,
      fw.target_port,
      fw.enabled ? 1 : 0,
      fw.id,
    ],
  );
  return fw.id;
}

export async function deletePortForward(id: number): Promise<void> {
  await ensure().execute(`DELETE FROM ssh_port_forwards WHERE id = $1`, [id]);
}

// ---------- broken sweep ----------

/** Called once at startup when the Stronghold snapshot was quarantined.
 *  Marks every key as broken and every password-auth host as broken so
 *  the UI can prompt the user to re-enter the missing secrets. */
export async function markAllBroken(): Promise<void> {
  await ensure().execute(
    `UPDATE ssh_hosts SET broken = 1 WHERE auth_method = 'password' AND has_password = 1`,
  );
  await ensure().execute(`UPDATE ssh_keys SET broken = 1`);
}
