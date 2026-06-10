-- Per-host opt-in for SFTP-only connections. When set, the backend never
-- opens a shell channel (works against ForceCommand internal-sftp accounts)
-- and the frontend renders the tab as a full-width file browser. Defaults
-- to 0 (shell on) so existing hosts keep the current behaviour.

ALTER TABLE ssh_hosts ADD COLUMN disable_ssh INTEGER NOT NULL DEFAULT 0;
