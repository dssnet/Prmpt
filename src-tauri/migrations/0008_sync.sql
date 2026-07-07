-- WebDAV sync support.
--
--   sync_id       — stable per-row identity that survives the round-trip
--                   through the sync document (numeric AUTOINCREMENT ids
--                   collide across devices). Nullable: rows inserted by an
--                   older binary get NULL and are backfilled lazily by the
--                   sync engine before it builds a document.
--   sync_tombstones — remembers deletions so a delete on one device wins
--                   over the stale copy on another (kind is 'host' | 'key'
--                   | 'group'). Rows are written by the db.ts delete
--                   helpers and reconciled with the remote document's
--                   tombstone set on every sync.
--   sync_meta     — key/value store for sync configuration + cursor state
--                   (server URL, username, enabled flag, last ETag, …).
--                   Secrets (WebDAV password, end-to-end passphrase) live
--                   in Stronghold, not here.

ALTER TABLE ssh_hosts  ADD COLUMN sync_id TEXT;
ALTER TABLE ssh_keys   ADD COLUMN sync_id TEXT;
ALTER TABLE ssh_groups ADD COLUMN sync_id TEXT;

-- randomblob() is evaluated per row, so every existing row gets a distinct id.
UPDATE ssh_hosts  SET sync_id = lower(hex(randomblob(16)));
UPDATE ssh_keys   SET sync_id = lower(hex(randomblob(16)));
UPDATE ssh_groups SET sync_id = lower(hex(randomblob(16)));

CREATE UNIQUE INDEX IF NOT EXISTS idx_hosts_sync_id  ON ssh_hosts(sync_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_keys_sync_id   ON ssh_keys(sync_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_sync_id ON ssh_groups(sync_id);

CREATE TABLE IF NOT EXISTS sync_tombstones (
  kind        TEXT NOT NULL,
  sync_id     TEXT NOT NULL,
  deleted_at  TEXT NOT NULL,
  PRIMARY KEY (kind, sync_id)
);

CREATE TABLE IF NOT EXISTS sync_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
