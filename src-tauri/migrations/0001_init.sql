CREATE TABLE IF NOT EXISTS ssh_keys (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  label             TEXT NOT NULL,
  private_key_ct    BLOB NOT NULL,
  private_key_nonce BLOB NOT NULL,
  passphrase_ct     BLOB,
  passphrase_nonce  BLOB,
  public_key        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ssh_hosts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT NOT NULL,
  hostname        TEXT NOT NULL,
  port            INTEGER NOT NULL DEFAULT 22,
  username        TEXT NOT NULL,
  auth_method     TEXT NOT NULL,
  password_ct     BLOB,
  password_nonce  BLOB,
  key_id          INTEGER REFERENCES ssh_keys(id) ON DELETE SET NULL,
  host_fp_sha256  TEXT,
  host_key_alg    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ssh_port_forwards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id       INTEGER NOT NULL REFERENCES ssh_hosts(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  bind_host     TEXT NOT NULL,
  bind_port     INTEGER NOT NULL,
  target_host   TEXT,
  target_port   INTEGER,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pf_host ON ssh_port_forwards(host_id);
