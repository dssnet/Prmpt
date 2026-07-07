-- Saved workspace layouts. A workspace is a tiling tree of terminal / ssh /
-- panel panes; `tree_json` stores an id-free, portable serialization of that
-- tree (see src/state/savedWorkspaces.ts). Loading one respawns the backends
-- (reconnecting ssh hosts by id, opening panels) into a fresh tab.
--
-- Device-local layout state: NOT part of the WebDAV sync document (no sync_id
-- / tombstone), same rationale as window layout in uiPrefs — the tree
-- references local `ssh_hosts.id`s, which aren't stable across installs.
CREATE TABLE IF NOT EXISTS saved_workspaces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL,
  tree_json   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
