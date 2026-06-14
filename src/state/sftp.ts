/**
 * Shared file-browser drag/selection machinery (used by the SFTP and local
 * browsers), plus the remembered "auto-open the file browser for new SSH
 * tabs" default.
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
/** The files currently being dragged (null when idle). Multi-select drags
 *  carry every selected entry; all items come from the same source browser. */
export const sftpDrag = ref<SftpDragItem[] | null>(null);
/** Floating drag label position (rendered by the panel). */
export const sftpDragGhost = ref<{ x: number; y: number; label: string } | null>(null);
/** The drop target currently under the cursor, for highlight. `dir` is the
 *  folder/cwd the file would land in. */
export const sftpDropHint = ref<FileDropTarget | null>(null);

// A browser registers a handler so another column's drop can hand it a
// cross-connection copy / download to perform + track (progress lands on the
// destination, so the destination owns the transfer). Keyed by the column's
// kind + tab id.
type SftpDropFn = (items: SftpDragItem[], dstDir: string) => void;
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
export function deliverSftpDrop(target: FileDropTarget, items: SftpDragItem[]): void {
  if (items.length === 0) return;
  dropTargets.get(dropKey(target.kind, target.tabId))?.(items, target.dir);
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
 * Begin a pointer drag for `items` (one entry, or the whole multi-selection)
 * from a row's mousedown. Shows the ghost + drop hint while moving; on
 * release over a valid target, calls `onDrop`. If the pointer never crosses
 * the threshold it's treated as a click (no drag, `onDrop` not called,
 * `onClick` called instead) so row navigation / selection-collapse still
 * work. The caller is responsible for ignoring mousedowns on action buttons
 * / inputs. All items must come from the same source browser.
 */
export function startFileDrag(
  items: SftpDragItem[],
  ev: MouseEvent,
  onDrop: (target: FileDropTarget) => void,
  onClick?: () => void,
): void {
  if (ev.button !== 0 || items.length === 0) return;
  const origin = { x: ev.clientX, y: ev.clientY };
  const label =
    items.length === 1 ? items[0].name : `${items.length} items`;

  const move = (e: MouseEvent) => {
    if (!sftpDrag.value) {
      const dx = e.clientX - origin.x;
      const dy = e.clientY - origin.y;
      if (dx * dx + dy * dy < 25) return; // 5px threshold before it's a drag
      sftpDrag.value = items;
    }
    sftpDragGhost.value = { x: e.clientX, y: e.clientY, label };
    const t = resolveDropTarget(e.clientX, e.clientY);
    // Hint only a meaningful drop (don't highlight a drop where every item
    // would land in its own current/parent dir on the same source). "Same
    // source" is the same connection for SFTP items, and any local column for
    // local items (all local columns are one filesystem) — never matched by
    // tab id alone, since a local column inside an SSH tab's panel shares
    // that tab's id.
    const sameSource =
      t != null &&
      (items[0].source === "local"
        ? t.kind === "local"
        : t.kind === "sftp" && t.tabId === items[0].srcTabId);
    const noop =
      sameSource &&
      items.every((i) => t!.dir === i.path || t!.dir === dropParent(i.path));
    sftpDropHint.value = t && !noop ? t : null;
  };

  const up = (e: MouseEvent) => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    const dragged = sftpDrag.value;
    sftpDrag.value = null;
    sftpDragGhost.value = null;
    sftpDropHint.value = null;
    if (!dragged) {
      onClick?.(); // never crossed threshold → a click, not a drag
      return;
    }
    const t = resolveDropTarget(e.clientX, e.clientY);
    if (!t || Number.isNaN(t.tabId)) return;
    onDrop(t);
  };

  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

// ---- marquee (rubber-band) selection ---------------------------------------

/** Marquee rectangle in the list container's *content* coordinates (i.e.
 *  inside the scrollable area, so it scrolls with the rows). */
export interface MarqueeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Begin a rubber-band selection from a mousedown on a list's empty area.
 * Rows opt in by stamping `data-marquee-path` (their entry path); every row
 * intersecting the rectangle is added to a copy of `base` (pass the current
 * selection for shift/cmd-additive marquees, an empty set otherwise) and
 * reported through `onUpdate` together with the rectangle to render. On
 * release, `onUpdate` fires once more with a `null` rect to hide it. If the
 * pointer never crosses the threshold it stays a plain click — `onUpdate` is
 * never called. Scrolls `container` when the pointer leaves it vertically.
 */
export function startMarqueeSelect(
  container: HTMLElement,
  ev: MouseEvent,
  base: ReadonlySet<string>,
  onUpdate: (selected: Set<string>, rect: MarqueeRect | null) => void,
): void {
  if (ev.button !== 0) return;
  const toContent = (cx: number, cy: number) => {
    const r = container.getBoundingClientRect();
    return {
      x: cx - r.left + container.scrollLeft,
      y: cy - r.top + container.scrollTop,
    };
  };
  const origin = toContent(ev.clientX, ev.clientY);
  let active = false;
  let lastSel = new Set(base);

  const move = (e: MouseEvent) => {
    const r = container.getBoundingClientRect();
    // Auto-scroll while the pointer is above/below the list.
    if (e.clientY < r.top) container.scrollTop += (e.clientY - r.top) / 3;
    else if (e.clientY > r.bottom) container.scrollTop += (e.clientY - r.bottom) / 3;

    const p = toContent(e.clientX, e.clientY);
    if (!active) {
      const dx = p.x - origin.x;
      const dy = p.y - origin.y;
      if (dx * dx + dy * dy < 16) return; // 4px threshold before it's a marquee
      active = true;
      document.body.style.userSelect = "none";
    }
    const rect: MarqueeRect = {
      x: Math.min(origin.x, p.x),
      y: Math.min(origin.y, p.y),
      w: Math.abs(p.x - origin.x),
      h: Math.abs(p.y - origin.y),
    };
    // Hit-test rows (client coords) against the marquee (content → client).
    const mLeft = rect.x - container.scrollLeft + r.left;
    const mTop = rect.y - container.scrollTop + r.top;
    const mRight = mLeft + rect.w;
    const mBottom = mTop + rect.h;
    const next = new Set(base);
    for (const el of container.querySelectorAll<HTMLElement>("[data-marquee-path]")) {
      const b = el.getBoundingClientRect();
      if (b.left < mRight && b.right > mLeft && b.top < mBottom && b.bottom > mTop) {
        next.add(el.dataset.marqueePath!);
      }
    }
    lastSel = next;
    onUpdate(next, rect);
  };

  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    if (!active) return; // never crossed threshold → plain click
    document.body.style.userSelect = "";
    onUpdate(lastSel, null);
  };

  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

// Whether a new SSH tab auto-opens a files panel pane. Follows the user's
// last explicit choice (opening/closing a files panel in an SSH context),
// persisted across restarts. Key name predates the panel system.
const AUTO_OPEN_KEY = "prmpt.sftpPanelShown";

const autoOpen = ref(localStorage.getItem(AUTO_OPEN_KEY) !== "0");

export function sftpAutoOpen(): boolean {
  return autoOpen.value;
}

export function setSftpAutoOpen(v: boolean): void {
  autoOpen.value = v;
  localStorage.setItem(AUTO_OPEN_KEY, v ? "1" : "0");
}
