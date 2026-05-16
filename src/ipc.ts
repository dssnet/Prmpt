import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

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

export async function showContextMenu(): Promise<void> {
  await invoke("show_context_menu");
}

export function onMenuCopy(handler: () => void): Promise<UnlistenFn> {
  return listen<void>("menu:copy", () => handler());
}

export function onMenuPaste(handler: () => void): Promise<UnlistenFn> {
  return listen<void>("menu:paste", () => handler());
}

export function onMenuSelectAll(handler: () => void): Promise<UnlistenFn> {
  return listen<void>("menu:selectAll", () => handler());
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
  return listen<RenderPayload>("terminal:render", (e) => handler(e.payload));
}

export function onExit(handler: (payload: ExitPayload) => void): Promise<UnlistenFn> {
  return listen<ExitPayload>("terminal:exit", (e) => handler(e.payload));
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
  return listen<TabAttachedPayload>("window:tab_attached", (e) => handler(e.payload));
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

export function onSshHostKeyMismatch(
  handler: (payload: SshHostKeyMismatch) => void,
): Promise<UnlistenFn> {
  return listen<SshHostKeyMismatch>("ssh:host_key_mismatch", (e) => handler(e.payload));
}

export function onSshHostKeyFirstConnect(
  handler: (payload: SshHostKeyFirstConnect) => void,
): Promise<UnlistenFn> {
  return listen<SshHostKeyFirstConnect>("ssh:host_key_first_connect", (e) =>
    handler(e.payload),
  );
}

export function onSshPortForwardError(
  handler: (payload: SshPortForwardError) => void,
): Promise<UnlistenFn> {
  return listen<SshPortForwardError>("ssh:port_forward_error", (e) => handler(e.payload));
}
