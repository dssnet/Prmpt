-- SSH host groups. Self-referencing parent_id gives arbitrary nesting
-- (group -> subgroup -> ...). parent_id NULL == top-level group.
-- ssh_hosts.group_id is nullable; NULL == ungrouped (shown only under
-- "All hosts").
--
-- NOTE: PRAGMA foreign_keys is OFF in the SQL plugin, so the REFERENCES
-- clauses below are intent/documentation only — cascades and reparenting
-- are done manually in db.ts (same pattern as deleteKey unlinking hosts).

CREATE TABLE IF NOT EXISTS ssh_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL,
  parent_id   INTEGER REFERENCES ssh_groups(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_groups_parent ON ssh_groups(parent_id);

ALTER TABLE ssh_hosts
  ADD COLUMN group_id INTEGER REFERENCES ssh_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_hosts_group ON ssh_hosts(group_id);
