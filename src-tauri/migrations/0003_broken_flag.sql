-- Per-row "broken" marker for rows that lost their Stronghold-stored
-- secret (almost always because the snapshot file was quarantined).
-- The frontend uses this to surface a "needs re-entry" badge and to
-- gate connects.
--
-- Cleared automatically when the user provides the missing secret via
-- the edit form (see `ssh_store::save_host` / `save_key`).

ALTER TABLE ssh_hosts ADD COLUMN broken INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ssh_keys ADD COLUMN broken INTEGER NOT NULL DEFAULT 0;
