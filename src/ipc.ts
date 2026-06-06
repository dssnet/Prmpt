import { invoke } from "@tauri-apps/api/core";
import { listen, type EventTarget as TauriEventTarget, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// In Tauri 2, the bare `listen(event, handler)` registers a listener with
// target=`Any`, which matches every emit regardless of its `emit_to` target.
// That means a hidden reserve window would receive `window:tab_attached`
// events meant for a different visible window, silently piling tabs into the
// reserve's state — surfaced only when the reserve was later popped for a
// real tear-off. Per-window scoping requires an explicit WebviewWindow target.
const MY_TARGET: TauriEventTarget = {
  kind: "WebviewWindow",
  label: getCurrentWebviewWindow().label,
};

function listenScoped<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload), { target: MY_TARGET });
}

export interface CellWire {
  ch: number;
  fg: number;
  bg: number;
  flags: number;
}

export interface CursorWire {
  x: number;
  y: number;
  visible: boolean;
  style: number;
  blinking: boolean;
}

export interface RenderPayload {
  tab_id: number;
  cols: number;
  rows: number;
  default_fg: number;
  default_bg: number;
  cells: CellWire[];
  cursor: CursorWire | null;
  generation: number;
  title: string;
  /** Screen-absolute row index of viewport row 0. Add to viewport row to get
   *  a coordinate that survives resize and scrollback motion. */
  viewport_top: number;
  /** Total scrollable rows (scrollback + visible viewport). Used by the
   *  scrollbar component to size and position the thumb. */
  scrollback_total: number;
}

export interface ExitPayload {
  tab_id: number;
  status: number;
}

export interface ThemeConfig {
  background: string;
  foreground: string;
  cursor: string;
  palette: string[];
}

export interface Config {
  font_family: string;
  font_size: number;
  line_height: number;
  shell: string | null;
  login_shell: boolean;
  scrollback_lines: number;
  theme: ThemeConfig;
}

export const FLAG_BOLD = 1 << 0;
export const FLAG_ITALIC = 1 << 1;
export const FLAG_UNDERLINE = 1 << 2;
export const FLAG_INVERSE = 1 << 3;
export const FLAG_FAINT = 1 << 4;
export const FLAG_STRIKETHROUGH = 1 << 5;
export const FLAG_WIDE = 1 << 6;
export const FLAG_SPACER_TAIL = 1 << 7;

export const CURSOR_BLOCK = 0;
export const CURSOR_BAR = 1;
export const CURSOR_UNDERLINE = 2;
export const CURSOR_BLOCK_HOLLOW = 3;

export async function spawnTab(args: {
  cols: number;
  rows: number;
  cellWidthPx: number;
  cellHeightPx: number;
}): Promise<number> {
  return await invoke<number>("spawn_tab", {
    args: {
      cols: args.cols,
      rows: args.rows,
      cell_width_px: args.cellWidthPx,
      cell_height_px: args.cellHeightPx,
    },
  });
}

export async function closeTab(tabId: number): Promise<void> {
  await invoke("close_tab", { tabId });
}

export async function forgetTab(tabId: number): Promise<void> {
  await invoke("forget_tab", { tabId });
}

export async function writeInput(tabId: number, bytes: Uint8Array): Promise<void> {
  await invoke("write_input", { tabId, bytes: Array.from(bytes) });
}

export async function resizeTab(args: {
  tabId: number;
  cols: number;
  rows: number;
  cellWidthPx: number;
  cellHeightPx: number;
}): Promise<void> {
  await invoke("resize_tab", {
    tabId: args.tabId,
    cols: args.cols,
    rows: args.rows,
    cellWidthPx: args.cellWidthPx,
    cellHeightPx: args.cellHeightPx,
  });
}

export type ScrollKind =
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "line_up" }
  | { kind: "line_down" }
  | { kind: "page_up" }
  | { kind: "page_down" }
  | { kind: "delta"; delta: number };

export async function scrollTab(tabId: number, kind: ScrollKind): Promise<void> {
  await invoke("scroll_tab", { tabId, kind });
}

/** Physical mouse-wheel notch in rows (negative = up). The backend routes it:
 *  arrow keys for an alternate-screen app (nano/less/vim) without mouse tracking,
 *  otherwise a scrollback viewport scroll. */
export async function wheelScroll(tabId: number, rows: number): Promise<void> {
  await invoke("wheel_scroll", { tabId, rows });
}

/** Extract the text of a screen-absolute selection range (inclusive, already
 *  ordered start→end). Reads from the full grid on the backend so selections
 *  that span scrollback — beyond the current viewport snapshot — copy correctly. */
export async function copySelectionText(
  tabId: number,
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
): Promise<string> {
  return await invoke("copy_selection_text", {
    tabId,
    startCol,
    startRow,
    endCol,
    endRow,
  });
}

export async function showContextMenu(): Promise<void> {
  await invoke("show_context_menu");
}

export function onMenuCopy(handler: () => void): Promise<UnlistenFn> {
  return listenScoped<void>("menu:copy", () => handler());
}

export function onMenuPaste(handler: () => void): Promise<UnlistenFn> {
  return listenScoped<void>("menu:paste", () => handler());
}

export function onMenuSelectAll(handler: () => void): Promise<UnlistenFn> {
  return listenScoped<void>("menu:selectAll", () => handler());
}

export async function getConfig(): Promise<Config> {
  return await invoke<Config>("get_config");
}

/** Whether macOS Full Disk Access is granted. Always true off macOS. */
export async function fullDiskAccessGranted(): Promise<boolean> {
  return await invoke<boolean>("full_disk_access_granted");
}

/** Opens System Settings → Privacy & Security → Full Disk Access. */
export async function openFullDiskAccessSettings(): Promise<void> {
  await invoke("open_full_disk_access_settings");
}

export async function setTheme(theme: ThemeConfig): Promise<void> {
  await invoke("set_theme", { theme });
}

export function onRender(handler: (payload: RenderPayload) => void): Promise<UnlistenFn> {
  return listenScoped<RenderPayload>("terminal:render", handler);
}

export function onExit(handler: (payload: ExitPayload) => void): Promise<UnlistenFn> {
  return listenScoped<ExitPayload>("terminal:exit", handler);
}

export interface TabInfo {
  id: number;
  title: string;
  kind: "terminal" | "ssh";
  host_id: number | null;
  host_label: string | null;
}

/** The `window:tab_attached` event used to carry just `{ tab_id }`; it now
 *  carries the full `TabInfo` so the receiving window can restore the
 *  tab's kind + host metadata without an extra round-trip. */
export type TabAttachedPayload = TabInfo;

export function currentWindowLabel(): string {
  return getCurrentWebviewWindow().label;
}

export async function closeCurrentWindow(): Promise<void> {
  await getCurrentWebviewWindow().close();
}

export async function tearOffTab(args: {
  tabId: number;
  screenX: number;
  screenY: number;
  width: number;
  height: number;
}): Promise<string> {
  return await invoke<string>("tear_off_tab", {
    args: {
      tab_id: args.tabId,
      screen_x: args.screenX,
      screen_y: args.screenY,
      width: args.width,
      height: args.height,
    },
  });
}

export async function attachTab(tabId: number, targetLabel: string): Promise<void> {
  await invoke("attach_tab", { tabId, targetLabel });
}

export async function listTabsForWindow(label: string): Promise<TabInfo[]> {
  return await invoke<TabInfo[]>("list_tabs_for_window", { label });
}

export type WindowMode = "reserve" | "normal";

export interface WindowBootstrap {
  mode: WindowMode;
  tabs: TabInfo[];
}

/** Tells the caller whether this window is a hidden reserve waiting for
 *  activation (sit idle, listeners stay subscribed) or a normal window
 *  that should hydrate listed tabs / spawn a fresh one. The very act of
 *  invoking this command also marks a `Reserve` window `Ready` on the
 *  backend so it becomes eligible for the next activation. */
export async function bootstrapWindow(label: string): Promise<WindowBootstrap> {
  return await invoke<WindowBootstrap>("bootstrap_window", { label });
}

/** Cmd+N (Ctrl+Shift+N elsewhere) — pop a reserve and surface it, or fall
 *  back to building a fresh window. */
export async function openNewWindow(): Promise<void> {
  await invoke("open_new_window");
}

/** Fires on a reserve when it's been popped for a blank activation
 *  (dock-click / openNewWindow). The frontend reacts by spawning its
 *  first tab. */
export function onWindowActivateBlank(handler: () => void): Promise<UnlistenFn> {
  return listenScoped<void>("window:activate-blank", () => handler());
}

export async function windowAtScreenPoint(
  x: number,
  y: number,
  exclude: string,
): Promise<string | null> {
  return await invoke<string | null>("window_at_screen_point", { x, y, exclude });
}

export function onTabAttached(
  handler: (payload: TabAttachedPayload) => void,
): Promise<UnlistenFn> {
  return listenScoped<TabAttachedPayload>("window:tab_attached", handler);
}

// ---------------- SSH connect (the only secret-touching Rust command) ----------------

/** Wire format the backend's `SshConnectConfig` deserializes into. The
 *  frontend assembles this from the SQL plugin (host row + port
 *  forwards) and the Stronghold plugin (decrypted secrets). */
export interface SshConnectConfig {
  host_id: number;
  label: string;
  hostname: string;
  port: number;
  username: string;
  auth: SshAuthConfig;
  stored_fingerprint: string | null;
  /** Per-host opt-out: skip opening the SFTP subsystem entirely. */
  disable_sftp: boolean;
  forwards: SshForwardConfig[];
}

export type SshAuthConfig =
  | { kind: "password"; password: string }
  | { kind: "key"; private_key: string; passphrase: string | null }
  | { kind: "agent" };

export interface SshForwardConfig {
  id: number | null;
  kind: "local" | "remote" | "dynamic";
  bind_host: string;
  bind_port: number;
  target_host: string | null;
  target_port: number | null;
}

export interface SshConnectArgs {
  config: SshConnectConfig;
  cols: number;
  rows: number;
  cellWidthPx: number;
  cellHeightPx: number;
}

export async function connectSshHost(args: SshConnectArgs): Promise<number> {
  return await invoke<number>("connect_ssh_host", {
    args: {
      config: args.config,
      cols: args.cols,
      rows: args.rows,
      cell_width_px: args.cellWidthPx,
      cell_height_px: args.cellHeightPx,
    },
  });
}

export interface SshKeyInfo {
  /** True if the key text parsed (with or without a passphrase being needed). */
  valid: boolean;
  /** True iff the key requires a passphrase to decode. */
  encrypted: boolean;
  /** Parser error string when `valid` is false. */
  error: string | null;
}

/** Cheap parse-only probe of a private-key text; reveals whether the key is
 *  encrypted so the UI can prompt for a passphrase. The key is not stored
 *  by the backend. */
export async function inspectSshKey(privateKey: string): Promise<SshKeyInfo> {
  return await invoke<SshKeyInfo>("inspect_ssh_key", { privateKey });
}

export interface SshHostKeyMismatch {
  tab_id: number;
  host_id: number;
  stored_fp: string;
  received_fp: string;
  algorithm: string;
}

export interface SshHostKeyFirstConnect {
  tab_id: number;
  host_id: number;
  fingerprint: string;
  algorithm: string;
}

export interface SshPortForwardError {
  tab_id: number;
  host_id: number;
  forward_id: number | null;
  message: string;
}

export type SshConnectErrorKind = "connect" | "auth" | "channel" | "other";

export interface SshConnectError {
  tab_id: number;
  host_id: number;
  host_label: string;
  hostname: string;
  message: string;
  kind: SshConnectErrorKind;
}

export function onSshHostKeyMismatch(
  handler: (payload: SshHostKeyMismatch) => void,
): Promise<UnlistenFn> {
  return listenScoped<SshHostKeyMismatch>("ssh:host_key_mismatch", handler);
}

export function onSshHostKeyFirstConnect(
  handler: (payload: SshHostKeyFirstConnect) => void,
): Promise<UnlistenFn> {
  return listenScoped<SshHostKeyFirstConnect>("ssh:host_key_first_connect", handler);
}

export function onSshPortForwardError(
  handler: (payload: SshPortForwardError) => void,
): Promise<UnlistenFn> {
  return listenScoped<SshPortForwardError>("ssh:port_forward_error", handler);
}

export function onSshConnectError(
  handler: (payload: SshConnectError) => void,
): Promise<UnlistenFn> {
  return listenScoped<SshConnectError>("ssh:connect_error", handler);
}

// ---------------- SFTP file browser ----------------

/** One entry in a remote directory listing. Metadata is best-effort — the
 *  server may omit any of `size`/`mtime`/`mode`. */
export interface SftpEntry {
  name: string;
  /** Absolute remote path. */
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  /** Unix mtime in epoch seconds, when reported. */
  mtime: number | null;
  /** Unix permission bits, when reported. */
  mode: number | null;
}

export async function sftpListDir(tabId: number, path: string): Promise<SftpEntry[]> {
  return await invoke<SftpEntry[]>("sftp_list_dir", { tabId, path });
}

/** Resolve a remote path (pass `"."` to get the login/home directory). */
export async function sftpRealpath(tabId: number, path: string): Promise<string> {
  return await invoke<string>("sftp_realpath", { tabId, path });
}

export async function sftpStat(tabId: number, path: string): Promise<SftpEntry> {
  return await invoke<SftpEntry>("sftp_stat", { tabId, path });
}

export async function sftpMkdir(tabId: number, path: string): Promise<void> {
  await invoke("sftp_mkdir", { tabId, path });
}

export async function sftpRename(tabId: number, from: string, to: string): Promise<void> {
  await invoke("sftp_rename", { tabId, from, to });
}

export async function sftpRemove(tabId: number, path: string, isDir: boolean): Promise<void> {
  await invoke("sftp_remove", { tabId, path, isDir });
}

/** Stream a remote file down to a local path. Progress arrives via
 *  `onSftpTransferProgress` keyed by `transferId`. */
export async function sftpDownload(
  tabId: number,
  remote: string,
  local: string,
  transferId: number,
): Promise<void> {
  await invoke("sftp_download", { tabId, remote, local, transferId });
}

/** Stream a local file up to a remote path. */
export async function sftpUpload(
  tabId: number,
  local: string,
  remote: string,
  transferId: number,
): Promise<void> {
  await invoke("sftp_upload", { tabId, local, remote, transferId });
}

/** Cross-connection copy: stream a remote file from `srcTab`'s SFTP session to
 *  `dstTab`'s, relayed through this process. Progress lands on `dstTab` via
 *  `onSftpTransferProgress`. */
export async function sftpRelay(
  srcTab: number,
  srcPath: string,
  dstTab: number,
  dstPath: string,
  transferId: number,
): Promise<void> {
  await invoke("sftp_relay", { srcTab, srcPath, dstTab, dstPath, transferId });
}

export interface SftpAvailability {
  tab_id: number;
  available: boolean;
}

/** Fires once per connect/reconnect when the SFTP subsystem is (or isn't)
 *  ready. The panel waits for `available: true` before its first load. */
export function onSftpAvailability(
  handler: (payload: SftpAvailability) => void,
): Promise<UnlistenFn> {
  return listenScoped<SftpAvailability>("sftp:availability", handler);
}

export interface SftpTransferProgress {
  tab_id: number;
  transfer_id: number;
  transferred: number;
  total: number | null;
  done: boolean;
  error: string | null;
}

export function onSftpTransferProgress(
  handler: (payload: SftpTransferProgress) => void,
): Promise<UnlistenFn> {
  return listenScoped<SftpTransferProgress>("sftp:transfer_progress", handler);
}

// ---------------- Local file browser ----------------

/** One entry in a local-filesystem directory listing. */
export interface LocalEntry {
  name: string;
  /** Absolute path (already joined by the backend). */
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  /** mtime in epoch seconds, when available. */
  mtime: number | null;
}

/** A local directory listing: the canonical directory, its parent (null at a
 *  filesystem root), and the sorted entries. */
export interface LocalListing {
  path: string;
  parent: string | null;
  entries: LocalEntry[];
}

/** A filesystem root the user can switch to from the drive picker. */
export interface LocalDrive {
  name: string;
  path: string;
}

/** The user's home directory — the local browser's starting point. */
export async function localHomeDir(): Promise<string> {
  return await invoke<string>("local_home_dir");
}

/** List filesystem roots: Windows drive letters, or mounted volumes elsewhere. */
export async function localDrives(): Promise<LocalDrive[]> {
  return await invoke<LocalDrive[]>("local_drives");
}

export async function listLocalDir(path: string): Promise<LocalListing> {
  return await invoke<LocalListing>("list_local_dir", { path });
}

export async function localMkdir(path: string): Promise<void> {
  await invoke("local_mkdir", { path });
}

export async function localRename(from: string, to: string): Promise<void> {
  await invoke("local_rename", { from, to });
}

export async function localRemove(path: string, isDir: boolean): Promise<void> {
  await invoke("local_remove", { path, isDir });
}

/** Reveal a path in the OS file manager (selected). */
export async function localReveal(path: string): Promise<void> {
  await invoke("local_reveal", { path });
}

/** Open a path with its default application. */
export async function localOpen(path: string): Promise<void> {
  await invoke("local_open", { path });
}

// ---- Backup (import / export) ----

export interface BackupSummary {
  /** Whether the backup file was passphrase-encrypted. */
  encrypted: boolean;
  /** Whether the backup carries decryptable SSH secrets (snapshot + key). */
  has_secrets: boolean;
}

/** Sentinel error string from `import_backup` when the file is encrypted
 *  but no passphrase was supplied — matched so the UI can prompt and retry,
 *  distinct from a wrong-passphrase error. Mirrors `backup::ERR_NEEDS_PASSPHRASE`. */
export const BACKUP_ENCRYPTED_NEEDS_PASSPHRASE = "BACKUP_ENCRYPTED_NEEDS_PASSPHRASE";

/** Write a backup of all app data to `path`. A non-empty `passphrase`
 *  age-encrypts the whole archive; omit it for a plain (unencrypted) backup. */
export async function exportBackup(path: string, passphrase?: string): Promise<void> {
  await invoke("export_backup", { path, passphrase: passphrase ?? null });
}

/** Stage a backup for import (decrypt + unzip + mark pending). The caller
 *  must relaunch the app afterwards so the staged data is applied at the next
 *  startup, before the DB is opened. */
export async function importBackup(
  path: string,
  passphrase?: string,
): Promise<BackupSummary> {
  return await invoke<BackupSummary>("import_backup", {
    path,
    passphrase: passphrase ?? null,
  });
}
