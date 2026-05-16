import { ref } from "vue";

import {
  FLAG_SPACER_TAIL,
  resizeTab,
  writeInput,
  type Config,
  type RenderPayload,
  type ThemeConfig,
} from "../ipc";
import { Canvas2DRenderer } from "../renderer/canvas2d";
import { measureCell, type Renderer, type SelectionRange } from "../renderer/index";
import { WebGLRenderer } from "../renderer/webgl";
import {
  activeSnapshot,
  dropTabIntoTarget,
  focusWorkspacePane,
  isInteractiveTab,
  isWorkspaceTab,
  snapshotFor,
  useTabs,
  type TabState,
} from "./tabs";
import {
  getWorkspace,
  layout as layoutWorkspace,
  markTabConsumed,
  setRatio,
  setWorkspace,
  GUTTER,
  type DividerRect,
  type PaneRect,
  type Workspace,
} from "./workspace";

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
  renderer = null;
  canvasEl = null;
  hostEl = null;
  config = null;
}

export function computeDims(): { cols: number; rows: number; w: number; h: number } {
  if (!hostEl) return { cols: 1, rows: 1, w: 0, h: 0 };
  const rect = hostEl.getBoundingClientRect();
  const cols = Math.max(1, Math.floor(rect.width / cellWidthPx));
  const rows = Math.max(1, Math.floor(rect.height / cellHeightPx));
  return { cols, rows, w: rect.width, h: rect.height };
}

/** Lay out the active workspace into the full host rect and tell each pane's
 *  backend tab its new cols/rows. Caches the layout for the draw/hit paths. */
function reflowWorkspaceLayout(ws: Workspace, w: number, h: number): void {
  const { panes, dividers, splitBoxes } = layoutWorkspace(ws.root, 0, 0, w, h);
  wsPanes = panes;
  wsDividers = dividers;
  wsSplitBoxes = splitBoxes;
  layoutVersion.value++;
  for (const pane of panes) {
    const cols = Math.max(1, Math.floor(pane.w / cellWidthPx));
    const rows = Math.max(1, Math.floor(pane.h / cellHeightPx));
    void resizeTab({
      tabId: pane.tabId,
      cols,
      rows,
      cellWidthPx: Math.round(cellWidthPx * dpr),
      cellHeightPx: Math.round(cellHeightPx * dpr),
    });
  }
}

export function getActiveDividers(): DividerRect[] {
  return activeWs() ? wsDividers : [];
}

export interface PaneOverlay extends PaneRect {
  title: string;
  focused: boolean;
}

/** Pane rects + titles for the active workspace, for DOM overlays (hover bar,
 *  close, move). Empty when the active tab isn't a workspace. */
export function getActivePanes(): PaneOverlay[] {
  const a = activeWs();
  if (!a) return [];
  return wsPanes.map((p) => ({
    ...p,
    title: snapshotFor(p.tabId)?.title || "Terminal",
    focused: p.tabId === a.ws.focusedTabId,
  }));
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
        const focused = pane.tabId === a.ws.focusedTabId;
        const sel =
          focused && selection ? selectionForRender(selection, snap) : null;
        renderer.renderInto(
          snap,
          sel,
          { x: pane.x, y: pane.y, w: pane.w, h: pane.h },
          { cursor: focused ? "full" : "none", cornerRadius: paneCornerRadius() },
        );
      }
    } finally {
      renderer.endFrame();
    }
    return;
  }
  const snap = focusedSnapshot();
  if (!snap) return;
  const sel = selection ? selectionForRender(selection, snap) : null;
  renderer.render(snap, sel);
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

/** Pull the selected text out of a viewport snapshot. Selection is in screen
 *  coords; if either endpoint sits outside the current viewport we return ""
 *  — the user scrolled away from the selected content and we no longer have
 *  those cells on hand. */
function extractSelection(p: RenderPayload, sel: Selection): string {
  const top = p.viewport_top;
  const norm = orderSelection(sel);
  const sRow = norm.start.screenRow - top;
  const eRow = norm.end.screenRow - top;
  if (sRow < 0 || eRow >= p.rows) return "";
  const lines: string[] = [];
  for (let row = sRow; row <= eRow; row++) {
    const c0 = row === sRow ? norm.start.col : 0;
    const c1Raw = row === eRow ? norm.end.col : p.cols - 1;
    const c1 = Math.min(c1Raw, p.cols - 1);
    let line = "";
    for (let col = c0; col <= c1; col++) {
      const cell = p.cells[row * p.cols + col];
      if (!cell) continue;
      if (cell.flags & FLAG_SPACER_TAIL) continue;
      line += cell.ch === 0 ? " " : String.fromCodePoint(cell.ch);
    }
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines.join("\n");
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
    if (pane) return { x: pane.x, y: pane.y };
  }
  return { x: 0, y: 0 };
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

export function onMouseDown(e: MouseEvent, activeKind: string | undefined): void {
  if (e.button !== 0) return;
  if (activeKind === "home") return;
  focusCanvas();
  // In a workspace, clicking a pane focuses it (routes input/selection there)
  // before any selection math runs.
  const a = activeWs();
  if (a) {
    const lp = localPoint(e);
    const hit = lp ? paneAt(lp.x, lp.y) : null;
    if (hit && hit.tabId !== a.ws.focusedTabId) {
      focusWorkspacePane(a.slotId, hit.tabId);
      selection = null;
      selectionTick.value++;
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
  if (!dragging) return;
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

export function onMouseUp(): void {
  const hadDrag = dragging && pendingAnchor === null;
  dragging = false;
  pendingAnchor = null;
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
  const text = extractSelection(snap, selection);
  if (text.length === 0) return;
  void navigator.clipboard.writeText(text).catch((err) => {
    console.error("clipboard write failed:", err);
  });
}

/** Tab id that keyboard / paste / scroll should target: the focused pane of
 *  the active workspace, or the active tab itself. Returns null for home. */
export function inputTargetTabId(): number | null {
  const { active } = useTabs();
  const a = active.value;
  if (!a || a.kind === "home") return null;
  const ws = activeWs();
  return ws ? ws.ws.focusedTabId : a.id;
}

export async function pasteFromClipboard(): Promise<void> {
  const target = inputTargetTabId();
  if (target == null) return;
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    void writeInput(target, new TextEncoder().encode(text));
  } catch (err) {
    console.error("clipboard read failed:", err);
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
  if (!activeTab || activeTab.kind === "home") return null;
  const lp = clientToLocal(clientX, clientY);
  if (!lp) return null;

  let rect: { x: number; y: number; w: number; h: number };
  let slotId: number;
  let targetPaneTabId: number;

  const a = activeWs();
  if (a) {
    const pane = paneAt(lp.x, lp.y);
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

  // Dropping a tab onto its own pane is a no-op (see dropTabIntoTarget);
  // suppress the preview so the active tab dragged over itself shows nothing.
  if (draggedId != null && draggedId === targetPaneTabId) return null;

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
