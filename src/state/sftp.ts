/**
 * SFTP panel visibility. The panel auto-opens for SSH tabs; a per-tab toggle
 * can hide it to reclaim full terminal width. The last-used choice is the
 * default for newly opened SSH tabs (persisted across restarts).
 */
import { ref } from "vue";

/** Cross-column drag payload: a file being dragged from one connection's
 *  browser, or from the local file browser. Held in shared state (not
 *  dataTransfer) because WKWebView doesn't reliably expose dataTransfer during
 *  dragover, and because the drop target lives in a different component
 *  instance. */
export interface SftpDragItem {
  /** Where the dragged file lives. `"local"` items dropped on an SFTP folder
   *  are uploaded; `"sftp"` items are moved (same host) or relayed (cross). */
  source: "sftp" | "local";
  /** For `"sftp"`, the source connection's tab id; for `"local"`, the tab id
   *  of the tab hosting the panel it was dragged from (may be an SSH tab when
   *  a local column sits inside an SSH tab's file panel — `source` is what
   *  distinguishes local items, not the id). */
  srcTabId: number;
  path: string;
  name: string;
  isDir: boolean;
}

/** A resolved drop location under the cursor: which browser column (a local
 *  column or an SFTP connection's column — their tab ids can collide, so the
 *  kind is part of the identity) and the destination directory. */
export interface FileDropTarget {
  kind: "sftp" | "local";
  tabId: number;
  dir: string;
}
/** The file currently being dragged (null when idle). */
export const sftpDrag = ref<SftpDragItem | null>(null);
/** Floating drag label position (rendered by the panel). */
export const sftpDragGhost = ref<{ x: number; y: number; label: string } | null>(null);
/** The drop target currently under the cursor, for highlight. `dir` is the
 *  folder/cwd the file would land in. */
export const sftpDropHint = ref<FileDropTarget | null>(null);

// A browser registers a handler so another column's drop can hand it a
// cross-connection copy / download to perform + track (progress lands on the
// destination, so the destination owns the transfer). Keyed by the column's
// kind + tab id.
type SftpDropFn = (item: SftpDragItem, dstDir: string) => void;
const dropTargets = new Map<string, SftpDropFn>();
function dropKey(kind: "sftp" | "local", tabId: number): string {
  return `${kind}:${tabId}`;
}
export function registerSftpTarget(
  kind: "sftp" | "local",
  tabId: number,
  fn: SftpDropFn,
): void {
  dropTargets.set(dropKey(kind, tabId), fn);
}
export function unregisterSftpTarget(
  kind: "sftp" | "local",
  tabId: number,
  fn: SftpDropFn,
): void {
  if (dropTargets.get(dropKey(kind, tabId)) === fn)
    dropTargets.delete(dropKey(kind, tabId));
}
export function deliverSftpDrop(target: FileDropTarget, item: SftpDragItem): void {
  dropTargets.get(dropKey(target.kind, target.tabId))?.(item, target.dir);
}

// ---- shared pointer-based drag source --------------------------------------
// WKWebView's HTML5 DnD is unreliable here, so we drive drags manually: track
// the pointer, show a ghost, and hit-test the element under the cursor on
// release via the `data-sftp-*` attrs any browser column stamps on its folders
// / listing. Shared by the SFTP and local browsers so the hit-test contract is
// single-sourced and drags work across columns, panes, and the two browsers.

/** Posix parent dir — used only for same-source "dropping into your own dir is
 *  a no-op" hinting; harmless on local Windows paths (it just won't match). */
function dropParent(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}

/** Resolve the drop target (connection/pane + destination dir) under a point. */
export function resolveDropTarget(x: number, y: number): FileDropTarget | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  const kindOf = (n: HTMLElement): "sftp" | "local" =>
    n.dataset.sftpKind === "local" ? "local" : "sftp";
  const folder = el.closest("[data-sftp-folder]") as HTMLElement | null;
  if (folder)
    return {
      kind: kindOf(folder),
      tabId: Number(folder.dataset.sftpTab),
      dir: folder.dataset.sftpFolder!,
    };
  const list = el.closest("[data-sftp-list]") as HTMLElement | null;
  if (list)
    return {
      kind: kindOf(list),
      tabId: Number(list.dataset.sftpTab),
      dir: list.dataset.sftpCwd || "/",
    };
  return null;
}

/**
 * Begin a pointer drag for `item` from a row's mousedown. Shows the ghost +
 * drop hint while moving; on release over a valid target, calls `onDrop`. If
 * the pointer never crosses the threshold it's treated as a click (no drag,
 * `onDrop` not called) so row navigation still works. The caller is
 * responsible for ignoring mousedowns on action buttons / inputs.
 */
export function startFileDrag(
  item: SftpDragItem,
  ev: MouseEvent,
  onDrop: (target: FileDropTarget) => void,
): void {
  if (ev.button !== 0) return;
  const origin = { x: ev.clientX, y: ev.clientY };

  const move = (e: MouseEvent) => {
    if (!sftpDrag.value) {
      const dx = e.clientX - origin.x;
      const dy = e.clientY - origin.y;
      if (dx * dx + dy * dy < 25) return; // 5px threshold before it's a drag
      sftpDrag.value = item;
    }
    sftpDragGhost.value = { x: e.clientX, y: e.clientY, label: item.name };
    const t = resolveDropTarget(e.clientX, e.clientY);
    // Hint only a meaningful drop (don't highlight dropping into the file's own
    // current/parent dir on the same source). "Same source" is the same
    // connection for SFTP items, and any local column for local items (all
    // local columns are one filesystem) — never matched by tab id alone, since
    // a local column inside an SSH tab's panel shares that tab's id.
    const sameSource =
      t != null &&
      (item.source === "local"
        ? t.kind === "local"
        : t.kind === "sftp" && t.tabId === item.srcTabId);
    const noop =
      sameSource && (t.dir === item.path || t.dir === dropParent(item.path));
    sftpDropHint.value = t && !noop ? t : null;
  };

  const up = (e: MouseEvent) => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    const dragged = sftpDrag.value;
    sftpDrag.value = null;
    sftpDragGhost.value = null;
    sftpDropHint.value = null;
    if (!dragged) return; // never crossed threshold → a click, not a drag
    const t = resolveDropTarget(e.clientX, e.clientY);
    if (!t || Number.isNaN(t.tabId)) return;
    onDrop(t);
  };

  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
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
