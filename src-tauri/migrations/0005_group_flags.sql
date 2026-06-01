-- Per-group UI/state flags.
--   open   — whether the group is expanded in the sidebar tree (remembers
--            the user's last expand/collapse so it survives restarts).
--   hidden — whether the group (and its subtree) is concealed behind the
--            PIN lock. Concealed groups and their hosts are hidden from the
--            list while the sidebar is locked; entering the PIN reveals them.
ALTER TABLE ssh_groups ADD COLUMN open   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ssh_groups ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
