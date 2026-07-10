import {
  readImage as readClipboardImage,
  readText as readClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";
import { ref } from "vue";

import {
  copySelectionText,
  resizeTab,
  scrollTab,
  writeInput,
  writeMouse,
  writePaste,
  type Config,
  type MouseEventWire,
  type RenderPayload,
  type ThemeConfig,
} from "../ipc";
import { IS_MAC } from "../input";
import { Canvas2DRenderer } from "../renderer/canvas2d";
import { measureCell, type Renderer, type SelectionRange } from "../renderer/index";
import { WebGLRenderer } from "../renderer/webgl";
import {
  activeSnapshot,
  dropPanelIntoTarget,
  dropTabIntoTarget,
  focusWorkspacePane,
  isInteractiveTab,
  isWorkspaceTab,
  snapshotFor,
  useTabs,
  type TabState,
} from "./tabs";
import {
  findLeafByTabId,
  getWorkspace,
  isPanelLeaf,
  layout as layoutWorkspace,
  markTabConsumed,
  setRatio,
  setWorkspace,
  GUTTER,
  type DividerRect,
  type PaneRect,
  type Workspace,
} from "./workspace";
import { isPanelLeafId, type PanelKind } from "./panels";
import {
  clearLinkHover,
  decoratePayloadForHover,
  findLinkAt,
  hoverCursor,
  openDetectedUrl,
  revalidateLinkHover,
  updateLinkHover,
  type LinkHit,
} from "./links";

// Selection lives in screen-absolute coords (`screenRow = viewport_top +
// viewport_row`). That way vertical resize and scrollback motion are pure
// coordinate translations — the same content keeps the same coords, and the
// drawing path just subtracts `viewport_top` on its way to the renderer.
// (Horizontal reflow when cols change is a separate phase-2 problem: the row
// is stable, but the logical line may rewrap onto a different screen row.)
type CellPoint = { col: number; screenRow: number };
type SelectionMode = "char" | "word" | "line";
type Selection = { anchor: CellPoint; head: CellPoint; mode: SelectionMode };

// Per-frame "did the body bg change?" guard — the body's CSS background is the
// terminal default_bg so the tab bar's backdrop-filter blurs the same color.
let lastBg = -1;

let renderer: Renderer | null = null;
let canvasEl: HTMLCanvasElement | null = null;
let hostEl: HTMLElement | null = null;
let cellWidthPx = 0;
let cellHeightPx = 0;
let dpr = 1;
let config: Config | null = null;

let selection: Selection | null = null;
const selectionTick = ref(0);

// Cached layout of the active workspace (CSS px, host-relative). Recomputed by
// reflowWorkspace; read by the draw path, hit-testing, and divider drags so
// none of them re-run the tree layout.
let wsPanes: PaneRect[] = [];
let wsDividers: DividerRect[] = [];
let wsSplitBoxes = new Map<string, { x: number; y: number; w: number; h: number }>();

/** A panel pane (file browser, git, …) tiled into the active workspace. The
 *  rect is host/canvas-relative CSS px; `tabId` is the panel leaf's negative
 *  frontend id (stable identity for keys, drag-rearrange, close). */
export interface PanelPane {
  tabId: number;
  kind: PanelKind;
  title: string;
  /** files: saved host the source was seeded with. */
  seedHostId?: number;
  /** Initial folder seed (local path). */
  seedPath?: string;
  /** files: initial cd / insert-path target terminal. */
  seedTargetTabId?: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
let wsPanelPanes: PanelPane[] = [];
// Inner padding (CSS px) between a workspace pane's edge and its cell grid,
// so the rounded-corner mask (--pane-radius) never clips edge glyphs. Must
// stay ≥ radius·(1 − 1/√2) ≈ 3.6px for the default 12px radius.
const PANE_PAD = 6;

// A workspace with a single pane renders full-bleed — no inner padding, corner
// radius, focus ring, or divider — so a lone terminal/panel fills the tab like
// the old standalone view. Set during reflow; `panePad()` is the pad used by
// the draw + coordinate-mapping paths.
let wsSinglePane = true;
function panePad(): number {
  return wsSinglePane ? 0 : PANE_PAD;
}

// Bumped whenever the cached workspace layout changes (reflow, resize,
// structural mutation) so views can refresh divider overlays.
export const layoutVersion = ref(0);

function activeWs(): { slotId: number; ws: Workspace } | null {
  const { activeId } = useTabs();
  const ws = getWorkspace(activeId.value);
  return ws ? { slotId: activeId.value, ws } : null;
}

export function useTerminalSelection() {
  return { selectionTick };
}

export function getCellMetrics(): { cellWidthPx: number; cellHeightPx: number; dpr: number } {
  return { cellWidthPx, cellHeightPx, dpr };
}

export function initTerminalSession(args: {
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  config: Config;
}): void {
  canvasEl = args.canvas;
  hostEl = args.host;
  config = args.config;
  dpr = window.devicePixelRatio || 1;
  const metrics = measureCell(args.config, 1);
  cellWidthPx = metrics.cellWidth;
  cellHeightPx = metrics.cellHeight;

  const useFallback = new URLSearchParams(location.search).get("renderer") === "2d";
  try {
    renderer = useFallback
      ? new Canvas2DRenderer(args.canvas, args.config)
      : new WebGLRenderer(args.canvas, args.config);
  } catch (e) {
    console.warn("WebGL renderer failed, falling back to Canvas2D:", e);
    renderer = new Canvas2DRenderer(args.canvas, args.config);
  }
}

export function teardownTerminalSession(): void {
  renderer?.dispose();
  renderer = null;
  canvasEl = null;
  hostEl = null;
  config = null;
  lastHoverCell = null;
  clearLinkHover();
}

export function computeDims(): { cols: number; rows: number; w: number; h: number } {
  if (!hostEl) return { cols: 1, rows: 1, w: 0, h: 0 };
  const rect = hostEl.getBoundingClientRect();
  const cols = Math.max(1, Math.floor(rect.width / cellWidthPx));
  const rows = Math.max(1, Math.floor(rect.height / cellHeightPx));
  return { cols, rows, w: rect.width, h: rect.height };
}

/** Split direction that leaves the halves of `tabId`'s pane closest to square:
 *  a wide pane splits side-by-side, a tall one top-and-bottom. Falls back to
 *  "h" when the pane hasn't rendered a snapshot yet. */
export function autoSplitDir(tabId: number): "h" | "v" {
  const snap = snapshotFor(tabId);
  if (!snap) return "h";
  return snap.rows * cellHeightPx > snap.cols * cellWidthPx ? "v" : "h";
}

/** Lay out the active workspace into the full host rect: terminal leaves get
 *  canvas rects (and their backend tabs new cols/rows); panel leaves get DOM
 *  overlay rects. Caches both for the draw path / hit-testing / overlays. */
function reflowWorkspaceLayout(ws: Workspace, w: number, h: number): void {
  const { panes, dividers, splitBoxes } = layoutWorkspace(ws.root, 0, 0, w, h);
  wsDividers = dividers;
  wsSplitBoxes = splitBoxes;

  const termPanes: PaneRect[] = [];
  const panelPanes: PanelPane[] = [];
  for (const pane of panes) {
    const leaf = findLeafByTabId(ws.root, pane.tabId);
    if (leaf && isPanelLeaf(leaf) && leaf.origin.panel) {
      panelPanes.push({
        ...pane,
        kind: leaf.origin.panel.kind,
        title: leaf.origin.title,
        seedHostId: leaf.origin.panel.seedHostId,
        seedPath: leaf.origin.panel.seedPath,
        seedTargetTabId: leaf.origin.panel.seedTargetTabId,
      });
    } else {
      termPanes.push(pane);
    }
  }
  wsPanes = termPanes;
  wsPanelPanes = panelPanes;
  wsSinglePane = panes.length === 1;
  layoutVersion.value++;
  const pad = panePad();
  for (const pane of wsPanes) {
    // The grid only gets the pane minus its inner padding (see PANE_PAD).
    const cols = Math.max(1, Math.floor((pane.w - 2 * pad) / cellWidthPx));
    const rows = Math.max(1, Math.floor((pane.h - 2 * pad) / cellHeightPx));
    void resizeTab({
      tabId: pane.tabId,
      cols,
      rows,
      cellWidthPx: Math.round(cellWidthPx * dpr),
      cellHeightPx: Math.round(cellHeightPx * dpr),
    });
  }
}

export function getActivePanelPanes(): PanelPane[] {
  return activeWs() ? wsPanelPanes : [];
}

export function getActiveDividers(): DividerRect[] {
  return activeWs() ? wsDividers : [];
}

export interface PaneOverlay extends PaneRect {
  title: string;
  focused: boolean;
  /** Local terminal pane (the git pill button only shows for these). */
  isLocalTerminal: boolean;
}

/** Terminal pane rects + titles for the active workspace, for DOM overlays
 *  (hover bar, close, move). Empty when the active tab isn't a workspace.
 *  Panel panes are listed separately via [`getActivePanelPanes`]. */
export function getActivePanes(): PaneOverlay[] {
  const a = activeWs();
  if (!a) return [];
  return wsPanes.map((p) => {
    const leaf = findLeafByTabId(a.ws.root, p.tabId);
    return {
      ...p,
      title: snapshotFor(p.tabId)?.title || "Terminal",
      focused: p.tabId === a.ws.focusedTabId,
      isLocalTerminal: !!leaf && leaf.origin.kind === "terminal",
    };
  });
}

export function reflowActive(activeTab: TabState | null): void {
  if (!renderer) return;
  const { cols, rows, w, h } = computeDims();
  renderer.resize(w, h, cols, rows);
  if (isWorkspaceTab(activeTab)) {
    const a = activeWs();
    if (a) reflowWorkspaceLayout(a.ws, w, h);
    drawNow();
    return;
  }
  // Setting canvas.width/height clears the WebGL drawing buffer to opaque
  // black (alpha:false). Must repaint synchronously before the browser
  // composites this frame — a rAF-scheduled redraw is too late and leaves
  // a black flash for the duration of the resize gesture. The repaint
  // uses the old snapshot (still sized for the old cols×rows, pinned
  // top-left in the new viewport) until the backend acks the resize and
  // emits a fresh snapshot a round-trip later.
  drawNow();
  if (isInteractiveTab(activeTab)) {
    void resizeTab({
      tabId: activeTab!.id,
      cols,
      rows,
      cellWidthPx: Math.round(cellWidthPx * dpr),
      cellHeightPx: Math.round(cellHeightPx * dpr),
    });
  }
}

export function pingAllForRedraw(allTabs: TabState[]): void {
  const dims = computeDims();
  for (const t of allTabs) {
    if (t.kind === "home") continue;
    // Workspace panes are sized by reflowWorkspaceLayout, not the full host
    // geometry — don't clobber them here.
    if (t.kind === "workspace") continue;
    void resizeTab({
      tabId: t.id,
      cols: dims.cols,
      rows: dims.rows,
      cellWidthPx: Math.round(cellWidthPx * dpr),
      cellHeightPx: Math.round(cellHeightPx * dpr),
    });
  }
}

export function applyRendererTheme(theme: ThemeConfig): void {
  if (config) config.theme = theme;
  renderer?.updateTheme(theme);
}

export function applyTerminalBg(rgb: number): void {
  if (rgb === lastBg) return;
  lastBg = rgb;
  const hex = "#" + rgb.toString(16).padStart(6, "0");
  document.body.style.background = hex;
}

export function focusCanvas(): void {
  canvasEl?.focus();
}

let scheduled = false;
export function requestDraw(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    drawActive();
  });
}

/** Synchronous repaint — bypasses the rAF coalescing in requestDraw().
 *  Use only when something has just invalidated the drawing buffer in the
 *  same tick (e.g. canvas.width = X clears WebGL to opaque black). The
 *  browser can composite between a ResizeObserver callback and the next
 *  rAF, so async repaint is too late and leaves a black flash. */
export function drawNow(): void {
  drawActive();
}

/** Pane corner radius (CSS px) for the WebGL content clip. Reads the single
 *  `--pane-radius` token so it always matches the `.pane-overlay` CSS border.
 *  Cached after first read. */
let _paneRadius: number | null = null;
function paneCornerRadius(): number {
  if (_paneRadius != null) return _paneRadius;
  const v = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(
      "--pane-radius",
    ),
  );
  _paneRadius = Number.isFinite(v) ? v : 12;
  return _paneRadius;
}

function drawActive(): void {
  if (!renderer) return;
  const a = activeWs();
  if (a) {
    renderer.beginFrame();
    try {
      for (const pane of wsPanes) {
        const snap = snapshotFor(pane.tabId);
        if (!snap) continue;
        // No-op for panes the pointer isn't over; for the hovered one, a new
        // generation re-runs the link hit-test so the underline follows
        // scroll/output or clears.
        if (revalidateLinkHover(snap)) syncHoverCursor();
        const focused = pane.tabId === a.ws.focusedTabId;
        const sel =
          focused && selection ? selectionForRender(selection, snap) : null;
        renderer.renderInto(
          decoratePayloadForHover(snap),
          sel,
          { x: pane.x, y: pane.y, w: pane.w, h: pane.h },
          {
            cursor: focused ? "full" : "none",
            // Full-bleed for a lone pane: no rounded corners or inner padding.
            cornerRadius: wsSinglePane ? 0 : paneCornerRadius(),
            padding: panePad(),
          },
        );
      }
    } finally {
      renderer.endFrame();
    }
    return;
  }
  const snap = focusedSnapshot();
  if (!snap) return;
  if (revalidateLinkHover(snap)) syncHoverCursor();
  const sel = selection ? selectionForRender(selection, snap) : null;
  renderer.render(decoratePayloadForHover(snap), sel);
}

/** Convert the screen-coord selection into the viewport-relative range the
 *  renderer expects, clipping pieces that fall above/below the current
 *  viewport. When an endpoint is clipped, we snap to the corresponding
 *  viewport corner — that turns the clipped row into a "middle" row from
 *  the renderer's perspective, which is the correct visual (a fully-selected
 *  row at the viewport edge representing the continuation of off-screen
 *  selection). Returns null if the selection is entirely outside the viewport. */
function selectionForRender(sel: Selection, p: RenderPayload): SelectionRange | null {
  const top = p.viewport_top;
  const norm = orderSelection(sel);
  const startRow = norm.start.screenRow - top;
  const endRow = norm.end.screenRow - top;
  if (endRow < 0 || startRow >= p.rows) return null;
  return {
    start:
      startRow < 0
        ? { col: 0, row: 0 }
        : { col: norm.start.col, row: startRow },
    end:
      endRow >= p.rows
        ? { col: p.cols - 1, row: p.rows - 1 }
        : { col: norm.end.col, row: endRow },
  };
}

function orderSelection(sel: Selection): { start: CellPoint; end: CellPoint } {
  const a = sel.anchor;
  const h = sel.head;
  const aFirst =
    a.screenRow < h.screenRow || (a.screenRow === h.screenRow && a.col <= h.col);
  return aFirst
    ? { start: { ...a }, end: { ...h } }
    : { start: { ...h }, end: { ...a } };
}

function isWordChar(cp: number): boolean {
  if (cp === 0) return false;
  if ((cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) return true;
  if (cp === 95 || cp === 45 || cp === 46 || cp === 47) return true; // _ - . /
  return cp > 127;
}

function expandSelectionWord(sel: Selection): void {
  const snap = focusedSnapshot();
  if (!snap) return;
  const viewportRow = sel.anchor.screenRow - snap.viewport_top;
  if (viewportRow < 0 || viewportRow >= snap.rows) return;
  const { col, screenRow } = sel.anchor;
  let lo = col;
  let hi = col;
  const rowStart = viewportRow * snap.cols;
  while (lo > 0 && isWordChar(snap.cells[rowStart + lo - 1]?.ch ?? 0)) lo--;
  while (hi < snap.cols - 1 && isWordChar(snap.cells[rowStart + hi + 1]?.ch ?? 0)) hi++;
  sel.anchor = { col: lo, screenRow };
  sel.head = { col: hi, screenRow };
}

function expandSelectionLine(sel: Selection): void {
  const snap = focusedSnapshot();
  if (!snap) return;
  const screenRow = sel.anchor.screenRow;
  sel.anchor = { col: 0, screenRow };
  sel.head = { col: Math.max(0, snap.cols - 1), screenRow };
}

/** Snapshot the selection/clipboard logic should act on: the focused pane's
 *  for a workspace, the active tab's otherwise. */
function focusedSnapshot(): RenderPayload | undefined {
  const a = activeWs();
  if (a) return snapshotFor(a.ws.focusedTabId);
  return activeSnapshot();
}

/** Origin (CSS px, host/canvas-relative) of the area pointer events map into:
 *  the focused pane for a workspace, the whole canvas otherwise. */
function pointerOrigin(): { x: number; y: number } {
  const a = activeWs();
  if (a) {
    const pane = wsPanes.find((p) => p.tabId === a.ws.focusedTabId);
    if (pane) return { x: pane.x + panePad(), y: pane.y + panePad() };
  }
  return { x: 0, y: 0 };
}

/** Height (CSS px) of the area pointer events map into: the focused pane for a
 *  workspace, the whole canvas otherwise. Pairs with `pointerOrigin`. */
function pointerAreaHeight(): number {
  const a = activeWs();
  if (a) {
    const pane = wsPanes.find((p) => p.tabId === a.ws.focusedTabId);
    if (pane) return pane.h - 2 * panePad();
  }
  return canvasEl ? canvasEl.getBoundingClientRect().height : 0;
}

function cellFromEvent(e: MouseEvent): CellPoint {
  if (!canvasEl) return { col: 0, screenRow: 0 };
  const r = canvasEl.getBoundingClientRect();
  const snap = focusedSnapshot();
  const origin = pointerOrigin();
  const maxCol = (snap?.cols ?? 1) - 1;
  const maxRow = (snap?.rows ?? 1) - 1;
  const localX = e.clientX - r.left - origin.x;
  const localY = e.clientY - r.top - origin.y;
  const col = Math.max(0, Math.min(maxCol, Math.floor(localX / cellWidthPx)));
  const viewportRow = Math.max(0, Math.min(maxRow, Math.floor(localY / cellHeightPx)));
  const top = snap?.viewport_top ?? 0;
  return { col, screenRow: top + viewportRow };
}

let dragging = false;
let pendingAnchor: CellPoint | null = null;
let lastClickAt = 0;
let lastClickCell: CellPoint | null = null;
let clickCount = 0;
/** Last pointer event seen during the active drag, kept so the auto-scroll
 *  timer can keep extending the selection while the pointer is held still
 *  outside the viewport. */
let lastDragEvent: MouseEvent | null = null;
let autoScrollTimer: number | null = null;

/** Vertical edge the pointer is past, relative to the focused area: -1 above
 *  the top, +1 below the bottom, 0 inside. */
function edgeDirection(e: MouseEvent): number {
  if (!canvasEl) return 0;
  const r = canvasEl.getBoundingClientRect();
  const localY = e.clientY - r.top - pointerOrigin().y;
  const h = pointerAreaHeight();
  if (localY < 0) return -1;
  if (h > 0 && localY > h) return 1;
  return 0;
}

/** Rows to scroll per auto-scroll tick, scaled by how far past the edge the
 *  pointer sits (clamped) so a small overshoot creeps and a big one races. */
function autoScrollLines(e: MouseEvent): number {
  if (!canvasEl || cellHeightPx <= 0) return 1;
  const r = canvasEl.getBoundingClientRect();
  const localY = e.clientY - r.top - pointerOrigin().y;
  const h = pointerAreaHeight();
  const over = localY < 0 ? -localY : Math.max(0, localY - h);
  return Math.max(1, Math.min(10, Math.ceil(over / cellHeightPx)));
}

function stopAutoScroll(): void {
  if (autoScrollTimer !== null) {
    window.clearInterval(autoScrollTimer);
    autoScrollTimer = null;
  }
}

function autoScrollTick(): void {
  if (!dragging || !lastDragEvent) {
    stopAutoScroll();
    return;
  }
  const dir = edgeDirection(lastDragEvent);
  if (dir === 0) {
    stopAutoScroll();
    return;
  }
  const tabId = inputTargetTabId();
  if (tabId == null) {
    stopAutoScroll();
    return;
  }
  void scrollTab(tabId, { kind: "delta", delta: dir * autoScrollLines(lastDragEvent) });
  // Re-pin the selection head to the edge row against the (about-to-update)
  // viewport; subsequent ticks pick up the new viewport_top from render events.
  applyDragMove(lastDragEvent);
}

/** Start the auto-scroll timer when the pointer is past a vertical edge, stop
 *  it when it returns inside. Idempotent — safe to call on every move. */
function updateAutoScroll(e: MouseEvent): void {
  if (edgeDirection(e) === 0) {
    stopAutoScroll();
    return;
  }
  if (autoScrollTimer === null) {
    autoScrollTimer = window.setInterval(autoScrollTick, 50);
  }
}

/** Apply a drag position to the selection head (or promote a pending anchor
 *  into a live selection). Shared by `onMouseMove` and the auto-scroll tick. */
function applyDragMove(e: MouseEvent): void {
  const p = cellFromEvent(e);
  if (pendingAnchor) {
    if (p.col === pendingAnchor.col && p.screenRow === pendingAnchor.screenRow) return;
    selection = { anchor: pendingAnchor, head: p, mode: "char" };
    pendingAnchor = null;
    selectionTick.value++;
    requestDraw();
    return;
  }
  if (!selection) return;
  selection.head = p;
  selectionTick.value++;
  requestDraw();
}

/** host/canvas-relative CSS-px point for a pointer event. */
function localPoint(e: MouseEvent): { x: number; y: number } | null {
  if (!canvasEl) return null;
  const r = canvasEl.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function paneAt(x: number, y: number): PaneRect | null {
  for (const pane of wsPanes) {
    if (x >= pane.x && x < pane.x + pane.w && y >= pane.y && y < pane.y + pane.h) {
      return pane;
    }
  }
  return null;
}

/** Panel pane under a host-relative point (drop targets only — panel panes
 *  never take terminal focus or selection). */
function panelPaneAt(x: number, y: number): PanelPane | null {
  for (const pane of wsPanelPanes) {
    if (x >= pane.x && x < pane.x + pane.w && y >= pane.y && y < pane.y + pane.h) {
      return pane;
    }
  }
  return null;
}

/** Cell under the pointer, resolved against the pane UNDER the pointer —
 *  unlike `cellFromEvent`, which maps into the *focused* pane (correct for
 *  selection, wrong for hover). Null outside any pane or without a snapshot. */
function cellAtPoint(
  e: MouseEvent,
): { snap: RenderPayload; col: number; viewportRow: number } | null {
  const lp = localPoint(e);
  if (!lp) return null;
  let snap: RenderPayload | undefined;
  let originX = 0;
  let originY = 0;
  if (activeWs()) {
    const pane = paneAt(lp.x, lp.y);
    if (!pane) return null;
    snap = snapshotFor(pane.tabId);
    originX = pane.x + panePad();
    originY = pane.y + panePad();
  } else {
    snap = activeSnapshot();
  }
  if (!snap) return null;
  const col = Math.floor((lp.x - originX) / cellWidthPx);
  const viewportRow = Math.floor((lp.y - originY) / cellHeightPx);
  if (col < 0 || col >= snap.cols || viewportRow < 0 || viewportRow >= snap.rows) {
    return null;
  }
  return { snap, col, viewportRow };
}

/** Link under a pointer event. Null when the pointer is over an overlay
 *  rather than the canvas itself, outside any pane, or simply not on a link. */
export function linkAtEvent(e: MouseEvent): LinkHit | null {
  if (e.target !== canvasEl) return null;
  const at = cellAtPoint(e);
  return at ? findLinkAt(at.snap, at.col, at.viewportRow) : null;
}

function syncHoverCursor(): void {
  if (canvasEl) canvasEl.style.cursor = hoverCursor();
}

/** Last hovered cell, so pointer motion within one cell skips the hit-test. */
let lastHoverCell: { tabId: number; col: number; viewportRow: number } | null = null;

export function onHoverMove(e: MouseEvent): void {
  if (dragging || e.target !== canvasEl) {
    onHoverLeave();
    return;
  }
  const hit = cellAtPoint(e);
  if (!hit) {
    onHoverLeave();
    return;
  }
  if (
    lastHoverCell &&
    lastHoverCell.tabId === hit.snap.tab_id &&
    lastHoverCell.col === hit.col &&
    lastHoverCell.viewportRow === hit.viewportRow
  ) {
    return;
  }
  lastHoverCell = { tabId: hit.snap.tab_id, col: hit.col, viewportRow: hit.viewportRow };
  if (updateLinkHover(hit.snap, hit.col, hit.viewportRow)) {
    syncHoverCursor();
    requestDraw();
  }
}

export function onHoverLeave(): void {
  lastHoverCell = null;
  if (clearLinkHover()) {
    syncHoverCursor();
    requestDraw();
  }
}

// ---- Mouse reporting (forward to apps that enabled mouse tracking) --------
//
// When the app under the pointer has a mouse-tracking mode active and Shift
// isn't held, clicks/drags/wheel are encoded and sent to the PTY (the backend
// turns them into the app's chosen format) instead of driving local selection.
// Shift always forces local selection — the only way to copy out of such apps.
let mouseReporting = false;
let mouseReportButton = 0;
let mouseReportTabId = 0;
let lastReportCell: { col: number; row: number } | null = null;

/** Focus the workspace pane under the pointer (no-op outside a workspace). */
function focusPaneUnder(e: MouseEvent): void {
  const a = activeWs();
  if (!a) return;
  const lp = localPoint(e);
  const hit = lp ? paneAt(lp.x, lp.y) : null;
  if (hit && hit.tabId !== a.ws.focusedTabId) {
    focusWorkspacePane(a.slotId, hit.tabId);
    selection = null;
    selectionTick.value++;
  }
}

/** Pointer cell + target tab when the app under the pointer wants mouse events
 *  and Shift isn't held. Null otherwise (→ local selection / menu). */
function mouseReportTarget(e: MouseEvent): { tabId: number; col: number; row: number } | null {
  if (e.shiftKey) return null;
  const at = cellAtPoint(e);
  if (!at || !at.snap.mouse_tracking) return null;
  return { tabId: at.snap.tab_id, col: at.col, row: at.viewportRow };
}

/** Whether a right-click/wheel at this event should be forwarded to the app
 *  rather than opening Prmpt's menu / scrolling scrollback. */
export function mouseReportActive(e: MouseEvent): boolean {
  return mouseReportTarget(e) !== null;
}

/** Pointer cell + target tab regardless of mouse mode — used by the wheel path,
 *  which the backend routes (report vs arrow keys vs scroll) on its own. */
export function pointerCell(e: MouseEvent): { tabId: number; col: number; row: number } | null {
  const at = cellAtPoint(e);
  return at ? { tabId: at.snap.tab_id, col: at.col, row: at.viewportRow } : null;
}

function mouseWire(
  action: MouseEventWire["action"],
  button: number,
  col: number,
  row: number,
  e: MouseEvent,
): MouseEventWire {
  return {
    action,
    button,
    col,
    row,
    shift: e.shiftKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    meta: e.metaKey,
  };
}

export function onMouseDown(e: MouseEvent, activeKind: string | undefined): void {
  if (activeKind === "home") return;
  // Forward to an app that enabled mouse tracking (Shift bypasses to local
  // selection). Runs before the left-button-only guard so middle/right clicks
  // reach the app too. DOM button ids (0/1/2) match the wire's left/middle/right.
  const rep = mouseReportTarget(e);
  if (rep && e.button <= 2) {
    focusCanvas();
    focusPaneUnder(e);
    // Cmd/ctrl+click on a link still opens it instead of reporting.
    if (IS_MAC ? e.metaKey : e.ctrlKey) {
      const link = linkAtEvent(e);
      if (link) {
        openDetectedUrl(link.url, link.source);
        e.preventDefault();
        return;
      }
    }
    mouseReporting = true;
    mouseReportButton = e.button;
    mouseReportTabId = rep.tabId;
    lastReportCell = { col: rep.col, row: rep.row };
    void writeMouse(rep.tabId, mouseWire("press", e.button, rep.col, rep.row, e));
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  focusCanvas();
  // In a workspace, clicking a pane focuses it (routes input/selection there)
  // before any selection math runs.
  focusPaneUnder(e);
  // Cmd/ctrl+click on a link opens it instead of starting a selection.
  if (IS_MAC ? e.metaKey : e.ctrlKey) {
    const link = linkAtEvent(e);
    if (link) {
      openDetectedUrl(link.url, link.source);
      e.preventDefault();
      return;
    }
  }
  const p = cellFromEvent(e);
  const now = performance.now();
  const sameSpot =
    lastClickCell &&
    lastClickCell.col === p.col &&
    lastClickCell.screenRow === p.screenRow;
  if (now - lastClickAt < 400 && sameSpot) clickCount++;
  else clickCount = 1;
  lastClickAt = now;
  lastClickCell = p;
  const mode: SelectionMode = clickCount >= 3 ? "line" : clickCount === 2 ? "word" : "char";

  if (selection) {
    selection = null;
    selectionTick.value++;
    requestDraw();
  }

  if (mode === "char") {
    pendingAnchor = p;
    dragging = true;
  } else {
    const sel: Selection = { anchor: p, head: p, mode };
    if (mode === "word") expandSelectionWord(sel);
    else expandSelectionLine(sel);
    selection = sel;
    pendingAnchor = null;
    dragging = false;
    selectionTick.value++;
    requestDraw();
  }
}

export function onMouseMove(e: MouseEvent): void {
  if (mouseReporting) {
    // Forward drag motion to the originating app (button held). Dedup by cell
    // here too; the backend also dedups via track_last_cell.
    const at = cellAtPoint(e);
    if (at && at.snap.tab_id === mouseReportTabId) {
      if (!lastReportCell || lastReportCell.col !== at.col || lastReportCell.row !== at.viewportRow) {
        lastReportCell = { col: at.col, row: at.viewportRow };
        void writeMouse(
          mouseReportTabId,
          mouseWire("motion", mouseReportButton, at.col, at.viewportRow, e),
        );
      }
    }
    return;
  }
  if (!dragging) return;
  lastDragEvent = e;
  applyDragMove(e);
  updateAutoScroll(e);
}

export function onMouseUp(): void {
  if (mouseReporting) {
    if (lastReportCell) {
      void writeMouse(mouseReportTabId, {
        action: "release",
        button: mouseReportButton,
        col: lastReportCell.col,
        row: lastReportCell.row,
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
      });
    }
    mouseReporting = false;
    lastReportCell = null;
    return;
  }
  const hadDrag = dragging && pendingAnchor === null;
  dragging = false;
  pendingAnchor = null;
  lastDragEvent = null;
  stopAutoScroll();
  if (selection) {
    const a = selection.anchor;
    const h = selection.head;
    const nonEmpty = a.screenRow !== h.screenRow || a.col !== h.col;
    if (nonEmpty && (hadDrag || selection.mode !== "char")) {
      copyCurrentSelection();
    }
  }
}

export function clearSelection(): void {
  stopAutoScroll();
  if (!selection) return;
  selection = null;
  selectionTick.value++;
  requestDraw();
}

export function selectAll(): void {
  const snap = focusedSnapshot();
  if (!snap || snap.cols <= 0 || snap.rows <= 0) return;
  const top = snap.viewport_top;
  selection = {
    anchor: { col: 0, screenRow: top },
    head: { col: snap.cols - 1, screenRow: top + snap.rows - 1 },
    mode: "char",
  };
  selectionTick.value++;
  requestDraw();
}

export function hasSelection(): boolean {
  return selection !== null;
}

export function copyCurrentSelection(): void {
  if (!selection) return;
  const snap = focusedSnapshot();
  if (!snap) return;
  const a = selection.anchor;
  const h = selection.head;
  if (a.screenRow === h.screenRow && a.col === h.col) return;
  const { start, end } = orderSelection(selection);
  // Extract from the backend grid (not the viewport snapshot) so selections
  // spanning scrollback copy in full.
  void copySelectionText(
    snap.tab_id,
    start.col,
    start.screenRow,
    end.col,
    end.screenRow,
  )
    .then((text) => {
      if (text.length === 0) return;
      return navigator.clipboard.writeText(text);
    })
    .catch((err) => {
      console.error("copy failed:", err);
    });
}

/** Tab id that keyboard / paste / scroll should target: the focused pane of
 *  the active workspace, or the active tab itself. Returns null for home. */
export function inputTargetTabId(): number | null {
  const { active } = useTabs();
  const a = active.value;
  if (!a || a.kind === "home") return null;
  const ws = activeWs();
  if (!ws) return a.id;
  // A panel-only SFTP workspace can have a panel focused (negative id): there
  // is no PTY to route keyboard / paste / scroll to, so target nothing.
  const focused = ws.ws.focusedTabId;
  return isPanelLeafId(focused) ? null : focused;
}

/** Paste into `targetTabId`, or the focused pane when omitted (keyboard
 *  chord / app menu). The context menu passes the pane that was right-clicked,
 *  which needn't be the focused one. */
export async function pasteFromClipboard(targetTabId?: number): Promise<void> {
  const target = targetTabId ?? inputTargetTabId();
  if (target == null) return;
  let text: string | null = null;
  try {
    text = await readClipboardText();
  } catch {
    // No text flavor on the clipboard (e.g. a screenshot) — not an
    // error; fall through to the image check.
  }
  if (text) {
    void writePaste(target, text);
    return;
  }
  // Image-only clipboard: a terminal can't paste pixels, but TUI apps
  // (Claude Code, …) read the clipboard image themselves when they see
  // Ctrl+V — forward that byte so the paste chord works for them too.
  try {
    const img = await readClipboardImage();
    await img.close();
    void writeInput(target, new Uint8Array([0x16]));
  } catch {
    // Clipboard empty or an unsupported flavor: nothing to paste.
  }
}

export interface DropResolution {
  slotId: number;
  targetPaneTabId: number;
  dir: "h" | "v";
  placeDraggedFirst: boolean;
  /** host-relative CSS-px rect to highlight (the half the new pane will take). */
  highlight: { x: number; y: number; w: number; h: number };
}

/** Live drop-zone highlight, set while a tab is dragged over the terminal.
 *  Rendered by TerminalView; driven by the tab's drag/dragend source events
 *  (reliable in WKWebView) plus the native dragover/drop path when available. */
export const wsDragPreview = ref<{
  x: number;
  y: number;
  w: number;
  h: number;
} | null>(null);

/** Convert a client (viewport) point to canvas/host-relative CSS px, or null
 *  if it falls outside the terminal canvas. */
function clientToLocal(
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (!canvasEl) return null;
  const r = canvasEl.getBoundingClientRect();
  if (
    clientX < r.left ||
    clientX > r.right ||
    clientY < r.top ||
    clientY > r.bottom
  ) {
    return null;
  }
  return { x: clientX - r.left, y: clientY - r.top };
}

/** Work out where a tab dropped at this client point would land: which pane,
 *  split direction, and the half it would occupy. */
export function resolveDropAt(
  clientX: number,
  clientY: number,
  draggedId?: number,
): DropResolution | null {
  const { active } = useTabs();
  const activeTab = active.value;
  if (!activeTab || activeTab.kind !== "workspace") return null;
  const lp = clientToLocal(clientX, clientY);
  if (!lp) return null;

  let rect: { x: number; y: number; w: number; h: number };
  let slotId: number;
  let targetPaneTabId: number;

  const a = activeWs();
  if (a) {
    // Terminal panes and panel panes are both valid split targets.
    const pane = paneAt(lp.x, lp.y) ?? panelPaneAt(lp.x, lp.y);
    if (!pane) return null;
    rect = { x: pane.x, y: pane.y, w: pane.w, h: pane.h };
    slotId = a.slotId;
    targetPaneTabId = pane.tabId;
  } else {
    const d = computeDims();
    rect = { x: 0, y: 0, w: d.w, h: d.h };
    slotId = activeTab.id;
    targetPaneTabId = activeTab.id;
  }

  // Dropping a tab onto its own pane — or a workspace tab onto any pane of
  // itself — is a no-op (see dropTabIntoTarget); suppress the preview so the
  // active tab dragged over itself shows nothing.
  if (draggedId != null && (draggedId === targetPaneTabId || draggedId === slotId)) {
    return null;
  }

  // Normalised position within the target pane. The cursor's nearest edge
  // picks the split axis (tiling-WM style); the half it sits in picks the
  // side the new pane takes.
  const px = (lp.x - rect.x) / Math.max(1, rect.w);
  const py = (lp.y - rect.y) / Math.max(1, rect.h);
  const horizontal = Math.min(px, 1 - px) < Math.min(py, 1 - py);
  const dir: "h" | "v" = horizontal ? "h" : "v";
  const placeDraggedFirst = horizontal ? px < 0.5 : py < 0.5;

  const highlight = horizontal
    ? {
        x: placeDraggedFirst ? rect.x : rect.x + rect.w / 2,
        y: rect.y,
        w: rect.w / 2,
        h: rect.h,
      }
    : {
        x: rect.x,
        y: placeDraggedFirst ? rect.y : rect.y + rect.h / 2,
        w: rect.w,
        h: rect.h / 2,
      };

  return { slotId, targetPaneTabId, dir, placeDraggedFirst, highlight };
}

/** Update (or clear) the drop highlight for a drag at this client point. */
export function updateWorkspaceDragPreview(
  clientX: number,
  clientY: number,
  draggedId?: number,
): void {
  // WKWebView sometimes emits (0,0) during a drag — ignore those samples.
  if (clientX === 0 && clientY === 0) return;
  const res = resolveDropAt(clientX, clientY, draggedId);
  wsDragPreview.value = res ? res.highlight : null;
}

export function clearWorkspaceDragPreview(): void {
  wsDragPreview.value = null;
}

/** True if a client point is over the terminal canvas of a non-home tab. */
export function pointOverTerminal(clientX: number, clientY: number): boolean {
  const { active } = useTabs();
  if (!active.value || active.value.kind === "home") return false;
  return clientToLocal(clientX, clientY) !== null;
}

/** Perform the drop of `draggedId` at this client point. Returns true if it
 *  was consumed into a workspace (caller should then skip tear-off). */
export function commitWorkspaceDrop(
  draggedId: number,
  clientX: number,
  clientY: number,
): boolean {
  const res = resolveDropAt(clientX, clientY, draggedId);
  wsDragPreview.value = null;
  if (!res) return false;
  const slot = dropTabIntoTarget(
    draggedId,
    res.slotId,
    res.targetPaneTabId,
    res.dir,
    res.placeDraggedFirst,
  );
  if (slot == null) return false;
  markTabConsumed();
  return true;
}

/** Like `commitWorkspaceDrop`, but drops a *new* panel (file browser / git)
 *  at this client point instead of an existing tab — for a + menu option
 *  dragged onto the terminal area. Returns true if it landed in a workspace. */
export function commitPanelWorkspaceDrop(
  kind: PanelKind,
  clientX: number,
  clientY: number,
): boolean {
  const res = resolveDropAt(clientX, clientY);
  wsDragPreview.value = null;
  if (!res) return false;
  const slot = dropPanelIntoTarget(
    kind,
    res.slotId,
    res.targetPaneTabId,
    res.dir,
    res.placeDraggedFirst,
  );
  if (slot == null) return false;
  markTabConsumed();
  return true;
}

/** Commit a divider drag: pointer position → new ratio for `splitId`. */
export function commitDividerDrag(splitId: string, e: MouseEvent): void {
  const a = activeWs();
  if (!a) return;
  const box = wsSplitBoxes.get(splitId);
  if (!box) return;
  const lp = localPoint(e);
  if (!lp) return;
  // Find the split to read its direction.
  const div = wsDividers.find((d) => d.splitId === splitId);
  if (!div) return;
  const ratio =
    div.dir === "h"
      ? (lp.x - box.x) / Math.max(1, box.w - GUTTER)
      : (lp.y - box.y) / Math.max(1, box.h - GUTTER);
  const root = setRatio(a.ws.root, splitId, ratio);
  setWorkspace(a.slotId, { root, focusedTabId: a.ws.focusedTabId });
}
