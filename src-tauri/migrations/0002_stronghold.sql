-- Migrate to Stronghold-backed secret storage.
--
-- Recreates `ssh_keys` and `ssh_hosts` without the ciphertext / nonce
-- columns (their data is unrecoverable anyway after the prior
-- keyring-mock bug) and adds boolean `has_*` flags so the frontend can
-- still display whether a secret is on file. The real secret bytes
-- now live in the Stronghold snapshot, keyed by
--   host:{id}:password
--   key:{id}:private
--   key:{id}:passphrase
--
-- `ssh_port_forwards` is unchanged.
--
-- SQLite's `ALTER TABLE DROP COLUMN` requires 3.35+ and macOS ships
-- older system SQLite on some releases, so we use the canonical
-- rename-recreate-copy pattern that works on every version.

PRAGMA foreign_keys = OFF;

CREATE TABLE ssh_keys_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT NOT NULL,
  has_passphrase  INTEGER NOT NULL DEFAULT 0,
  public_key      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

INSERT INTO ssh_keys_new (id, label, has_passphrase, public_key, created_at, updated_at)
SELECT id, label, 0, public_key, created_at, updated_at
FROM ssh_keys;

DROP TABLE ssh_keys;
ALTER TABLE ssh_keys_new RENAME TO ssh_keys;

CREATE TABLE ssh_hosts_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT NOT NULL,
  hostname        TEXT NOT NULL,
  port            INTEGER NOT NULL DEFAULT 22,
  username        TEXT NOT NULL,
  auth_method     TEXT NOT NULL,
  has_password    INTEGER NOT NULL DEFAULT 0,
  key_id          INTEGER REFERENCES ssh_keys(id) ON DELETE SET NULL,
  host_fp_sha256  TEXT,
  host_key_alg    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

INSERT INTO ssh_hosts_new (id, label, hostname, port, username, auth_method, has_password,
                          key_id, host_fp_sha256, host_key_alg, created_at, updated_at)
SELECT id, label, hostname, port, username, auth_method, 0,
       key_id, host_fp_sha256, host_key_alg, created_at, updated_at
FROM ssh_hosts;

DROP TABLE ssh_hosts;
ALTER TABLE ssh_hosts_new RENAME TO ssh_hosts;

PRAGMA foreign_keys = ON;
