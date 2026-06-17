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

/** One run of cells covered by an OSC 8 hyperlink. `row` is viewport-relative,
 *  `c0..c1` the inclusive column range, `link` an index into
 *  `RenderPayload.links`. */
export interface LinkSpanWire {
  row: number;
  c0: number;
  c1: number;
  link: number;
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
  /** Current kitty keyboard protocol flags (bit 1 = disambiguate, bit 2 =
   *  report events, …). Keys are encoded on the backend; this is only a
   *  traffic hint so the frontend can skip forwarding key-release and
   *  bare-modifier events the encoder would discard anyway. */
  kitty_flags: number;
  /** Deduped OSC 8 hyperlink URIs visible this frame. */
  links: string[];
  /** Cell runs covered by those hyperlinks (viewport coordinates). */
  link_spans: LinkSpanWire[];
}

export interface ExitPayload {
  tab_id: number;
  status: number;
}

/** A keyboard event for the backend's `write_key`, which encodes it with
 *  libghostty-vt's key encoder against the terminal's live modes. Field
 *  names mirror the W3C KeyboardEvent concepts they're lifted from. */
export interface KeyEventWire {
  /** DOM `KeyboardEvent.code` (physical key, e.g. "KeyA", "ArrowUp"). */
  code: string;
  action: "press" | "release" | "repeat";
  /** Layout-produced text (DOM `key` when a single printable grapheme),
   *  pre-Ctrl transformation; null for named keys. */
  utf8: string | null;
  /** Codepoint of the key without shift applied; 0 when not applicable. */
  unshifted_codepoint: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  super_key: boolean;
  caps_lock: boolean;
  num_lock: boolean;
}

/** `terminal:notification` — a program rang the bell (BEL) or sent an OSC
 *  9 / OSC 777 desktop notification (how Claude Code announces a finished
 *  task). Throttled to one per second per tab on the backend. */
export interface NotifyPayload {
  tab_id: number;
  source: "bell" | "osc";
  title: string | null;
  body: string | null;
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
  ui: UiPrefs;
  /** User keyboard-shortcut overrides: action id → serialized chord. Only
   *  actions that differ from their default appear here. */
  keybindings: Record<string, string>;
}

/** UI behavior preferences, persisted in config.toml's `[ui]` section. */
export interface UiPrefs {
  toast_notifications: boolean;
  notification_sounds: boolean;
  confirm_close_running: boolean;
  show_hidden_files: boolean;
  show_size: boolean;
  show_changed_date: boolean;
  show_created_date: boolean;
  auto_open_update_dialog: boolean;
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

/** The process group in the foreground of a local tab's PTY when it isn't
 *  the shell itself — i.e. a program is running there. `null` for idle
 *  shells, SSH tabs and on Windows. */
export interface ForegroundProcess {
  pid: number;
  name: string | null;
}

export async function tabForegroundProcess(
  tabId: number,
): Promise<ForegroundProcess | null> {
  return await invoke<ForegroundProcess | null>("tab_foreground_process", {
    tabId,
  });
}

export async function writeInput(tabId: number, bytes: Uint8Array): Promise<void> {
  await invoke("write_input", { tabId, bytes: Array.from(bytes) });
}

/** Forward a keyboard event for backend-side encoding (legacy sequences,
 *  DECCKM, kitty keyboard protocol — whatever the terminal's modes say). */
export async function writeKey(tabId: number, event: KeyEventWire): Promise<void> {
  await invoke("write_key", { tabId, event });
}

/** Paste text; the backend wraps it in bracketed-paste markers when the
 *  application enabled DEC mode 2004. */
export async function writePaste(tabId: number, text: string): Promise<void> {
  await invoke("write_paste", { tabId, bytes: Array.from(new TextEncoder().encode(text)) });
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

// The Copy / Paste / Select All menu events below are emitted by the macOS app
// menu bar's keyboard accelerators (see `install_app_menu` in lib.rs). The
// right-click context menu is now an in-webview FloatingMenu, so there is no
// `show_context_menu` command or `menu:copy_link` event any more.
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

/** Built-in defaults (Config::default()), for reset-to-defaults actions. */
export async function defaultTerminalConfig(): Promise<Config> {
  return await invoke<Config>("default_terminal_config");
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

export async function setUiPrefs(ui: UiPrefs): Promise<void> {
  await invoke("set_ui_prefs", { ui });
}

/** Persist keyboard-shortcut overrides (action id → serialized chord). */
export async function setKeybindings(keybindings: Record<string, string>): Promise<void> {
  await invoke("set_keybindings", { keybindings });
}

/** The terminal-core subset of `Config`, editable from the settings pane. */
export interface TerminalPrefs {
  font_family: string;
  font_size: number;
  line_height: number;
  shell: string | null;
  login_shell: boolean;
  scrollback_lines: number;
}

export async function setTerminalPrefs(prefs: TerminalPrefs): Promise<void> {
  await invoke("set_terminal_prefs", { prefs });
}

export function onRender(handler: (payload: RenderPayload) => void): Promise<UnlistenFn> {
  return listenScoped<RenderPayload>("terminal:render", handler);
}

export function onExit(handler: (payload: ExitPayload) => void): Promise<UnlistenFn> {
  return listenScoped<ExitPayload>("terminal:exit", handler);
}

export function onTerminalNotification(
  handler: (payload: NotifyPayload) => void,
): Promise<UnlistenFn> {
  return listenScoped<NotifyPayload>("terminal:notification", handler);
}

export interface TabInfo {
  id: number;
  title: string;
  kind: "terminal" | "ssh";
  host_id: number | null;
  host_label: string | null;
  /** SSH per-host flags, carried so hydrate/tear-off restores the right
   *  tab chrome. Always `false` for local tabs. */
  disable_sftp: boolean;
  disable_ssh: boolean;
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

/** Like `openNewWindow`, but the surfaced window opens a frontend panel
 *  (file browser / git) instead of a terminal — for dragging a + menu
 *  option out into its own window. */
export async function openPanelWindow(kind: "files" | "git"): Promise<void> {
  await invoke("open_panel_window", { kind });
}

/** Payload for `window:activate-blank`. `panel` (when set) asks the surfaced
 *  window to open that panel kind instead of spawning a terminal. */
export interface ActivateBlankPayload {
  panel?: "files" | "git" | null;
}

/** Fires on a reserve when it's been popped for a blank activation
 *  (dock-click / openNewWindow / openPanelWindow). The frontend reacts by
 *  spawning its first tab, or opening the requested panel. */
export function onWindowActivateBlank(
  handler: (payload: ActivateBlankPayload) => void,
): Promise<UnlistenFn> {
  return listenScoped<ActivateBlankPayload>("window:activate-blank", (p) =>
    handler(p ?? {}),
  );
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
  /** Per-host opt-in for SFTP-only connections: never open a shell channel. */
  disable_ssh: boolean;
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

/** Acquire an SFTP consumer on a host's pooled connection (the file browser's
 *  own channel). Returns the consumer id used to route every `sftp_*` call and
 *  to `sftpRelease` it. */
export async function sftpAcquire(config: SshConnectConfig): Promise<number> {
  return await invoke<number>("sftp_acquire", { config });
}

/** Release a previously-acquired SFTP consumer (drops the channel, and the
 *  host connection when it was the last consumer). */
export async function sftpRelease(consumerId: number): Promise<void> {
  await invoke("sftp_release", { consumerId });
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

/** Resolve a pending first-connect host-key prompt. The SSH handshake is
 *  parked until this delivers the verdict; rejecting aborts the connection
 *  before any credentials are sent. */
export async function sshConfirmHostKey(hostId: number, accept: boolean): Promise<void> {
  await invoke("ssh_confirm_host_key", { hostId, accept });
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

/** Fires whenever a working session drops and the backend is about to retry.
 *  Shell tabs already show the reconnect banner in the terminal; SFTP-only
 *  tabs have no visible VT, so the frontend toasts off this instead. */
export interface SshReconnecting {
  tab_id: number;
  host_id: number;
  host_label: string;
}

export function onSshReconnecting(
  handler: (payload: SshReconnecting) => void,
): Promise<UnlistenFn> {
  return listenScoped<SshReconnecting>("ssh:reconnecting", handler);
}

/** Fires on every successful (re)connect, right when the channels are up.
 *  Clears the per-tab reconnecting state that gates Ctrl+C-cancels-reconnect. */
export interface SshConnected {
  tab_id: number;
  host_id: number;
  host_label: string;
}

export function onSshConnected(
  handler: (payload: SshConnected) => void,
): Promise<UnlistenFn> {
  return listenScoped<SshConnected>("ssh:connected", handler);
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

/** Delete a remote file or directory (recursive). Directory deletes report
 *  progress via `onSftpTransferProgress` keyed by `transferId`, with
 *  `transferred` counting removed entries (no byte total). */
export async function sftpRemove(
  tabId: number,
  path: string,
  isDir: boolean,
  transferId: number,
): Promise<void> {
  await invoke("sftp_remove", { tabId, path, isDir, transferId });
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
  /** Creation time in epoch seconds; null where the OS/filesystem lacks it. */
  created: number | null;
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

// ---------------- Git panel ----------------

/** One changed file in the status snapshot. `status` is a stable word, not
 *  git's letter codes ("modified"|"added"|"deleted"|"renamed"|"copied"|
 *  "typechange"|"untracked"|"conflicted"). */
export interface GitFileEntry {
  /** Repo-relative path. */
  path: string;
  /** Rename/copy source, when status is "renamed"/"copied". */
  orig_path: string | null;
  status: string;
}

/** Distilled `git status`: branch info + changes split into the index
 *  (`staged`) and worktree (`unstaged`, includes untracked). A file modified
 *  in both places appears in both lists. */
export interface GitStatusSnapshot {
  /** Canonical repo toplevel — pass this as `repo` to the other git calls. */
  root: string;
  /** Null when HEAD is detached (see detached_at) or the repo is empty. */
  branch: string | null;
  /** Short hash shown instead of a branch name while detached. */
  detached_at: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
}

/** "git_missing" and "not_a_repo" are normal panel empty states, not errors. */
export type GitRepoStatus =
  | { kind: "git_missing" }
  | { kind: "not_a_repo" }
  | ({ kind: "repo" } & GitStatusSnapshot);

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitCommit {
  hash: string;
  author: string;
  /** Author time in epoch seconds. */
  time: number;
  subject: string;
}

/** Working directory of a local tab's shell process, queried from the OS
 *  (follows `cd`, no shell integration needed). Null for SSH tabs, dead
 *  shells, and Windows (no public cwd API) — fall back to the file browser. */
export async function terminalCwd(tabId: number): Promise<string | null> {
  return await invoke<string | null>("terminal_cwd", { tabId });
}

/** Resolve `dir` to its enclosing repo (backend walks up) and snapshot it. */
export async function gitStatus(dir: string): Promise<GitRepoStatus> {
  return await invoke<GitRepoStatus>("git_status", { dir });
}

export async function gitStage(repo: string, paths: string[]): Promise<void> {
  await invoke("git_stage", { repo, paths });
}

export async function gitUnstage(repo: string, paths: string[]): Promise<void> {
  await invoke("git_unstage", { repo, paths });
}

/** Commit the index. Resolves to git's summary output; rejects with stderr
 *  (hook failure, no user.name, …) for the panel's error slot. */
export async function gitCommitChanges(
  repo: string,
  message: string,
): Promise<string> {
  return await invoke<string>("git_commit_changes", { repo, message });
}

/** Unified diff for one file: index→HEAD when `staged`, worktree→index
 *  otherwise; untracked files diff against /dev/null. */
export async function gitDiffFile(
  repo: string,
  path: string,
  staged: boolean,
  untracked: boolean,
): Promise<string> {
  return await invoke<string>("git_diff_file", { repo, path, staged, untracked });
}

export async function gitBranches(repo: string): Promise<GitBranch[]> {
  return await invoke<GitBranch[]>("git_branches", { repo });
}

export async function gitSwitchBranch(
  repo: string,
  name: string,
): Promise<void> {
  await invoke("git_switch_branch", { repo, name });
}

export async function gitCreateBranch(
  repo: string,
  name: string,
): Promise<void> {
  await invoke("git_create_branch", { repo, name });
}

export async function gitLog(repo: string, limit: number): Promise<GitCommit[]> {
  return await invoke<GitCommit[]>("git_log", { repo, limit });
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
