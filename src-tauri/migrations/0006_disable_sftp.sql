-- Per-host opt-out for the SFTP file browser. When set, the connect path
-- tells the backend not to open the SFTP subsystem, and the frontend keeps
-- the file-browser panel hidden for that connection. Defaults to 0 (SFTP on)
-- so existing hosts keep the new behaviour without a re-save.

ALTER TABLE ssh_hosts ADD COLUMN disable_sftp INTEGER NOT NULL DEFAULT 0;
