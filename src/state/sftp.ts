/**
 * SFTP panel visibility. The panel auto-opens for SSH tabs; a per-tab toggle
 * can hide it to reclaim full terminal width. The last-used choice is the
 * default for newly opened SSH tabs (persisted across restarts).
 */
import { ref } from "vue";

/** Cross-column drag payload: a file being dragged from one connection's
 *  browser. Held in shared state (not dataTransfer) because WKWebView doesn't
 *  reliably expose dataTransfer during dragover, and because the drop target
 *  lives in a different component instance. */
export interface SftpDragItem {
  srcTabId: number;
  path: string;
  name: string;
  isDir: boolean;
}
/** The file currently being dragged (null when idle). */
export const sftpDrag = ref<SftpDragItem | null>(null);
/** Floating drag label position (rendered by the panel). */
export const sftpDragGhost = ref<{ x: number; y: number; label: string } | null>(null);
/** The drop target currently under the cursor, for highlight. `dir` is the
 *  folder/cwd the file would land in. */
export const sftpDropHint = ref<{ tabId: number; dir: string } | null>(null);

// A browser registers a handler so another column's drop can hand it a
// cross-connection copy to perform + track (progress lands on the destination,
// so the destination owns the transfer). Keyed by the column's connection id.
type SftpDropFn = (item: SftpDragItem, dstDir: string) => void;
const dropTargets = new Map<number, SftpDropFn>();
export function registerSftpTarget(tabId: number, fn: SftpDropFn): void {
  dropTargets.set(tabId, fn);
}
export function unregisterSftpTarget(tabId: number, fn: SftpDropFn): void {
  if (dropTargets.get(tabId) === fn) dropTargets.delete(tabId);
}
export function deliverSftpDrop(tabId: number, item: SftpDragItem, dstDir: string): void {
  dropTargets.get(tabId)?.(item, dstDir);
}

const SHOWN_KEY = "prmpt.sftpPanelShown";

// Global default applied to any tab the user hasn't explicitly toggled.
const defaultShown = ref(localStorage.getItem(SHOWN_KEY) !== "0");
// Per-tab overrides (tab ids are ephemeral, so this isn't persisted).
const overrides = ref<Record<number, boolean>>({});

export function isSftpVisible(tabId: number): boolean {
  return overrides.value[tabId] ?? defaultShown.value;
}

export function toggleSftpPanel(tabId: number): void {
  const next = !isSftpVisible(tabId);
  overrides.value = { ...overrides.value, [tabId]: next };
  defaultShown.value = next;
  localStorage.setItem(SHOWN_KEY, next ? "1" : "0");
}

/** Drop a closed tab's override so the map doesn't grow unbounded. */
export function forgetSftpPanel(tabId: number): void {
  if (tabId in overrides.value) {
    const next = { ...overrides.value };
    delete next[tabId];
    overrides.value = next;
  }
}

// Fraction of an SSH workspace pane's height given to its docked SFTP browser
// (the rest is the terminal). Shared across panes, persisted, drag-adjustable.
const DOCK_RATIO_KEY = "prmpt.sftpDockRatio";
const savedDockRatio = parseFloat(localStorage.getItem(DOCK_RATIO_KEY) ?? "");
const dockRatio = ref(
  Number.isFinite(savedDockRatio) ? Math.min(0.75, Math.max(0.15, savedDockRatio)) : 0.4,
);

export function sftpDockRatio(): number {
  return dockRatio.value;
}
export function setSftpDockRatio(r: number): void {
  const clamped = Math.min(0.75, Math.max(0.15, r));
  dockRatio.value = clamped;
  localStorage.setItem(DOCK_RATIO_KEY, clamped.toFixed(3));
}
