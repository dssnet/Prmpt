import { ref } from "vue";
import {
  emitTo,
  listen,
  type EventTarget as TauriEventTarget,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import {
  attachTab,
  closeCurrentWindow,
  openPanelWindow,
  tearOffTab,
  tearOffWindow,
  windowAtScreenPoint,
  windowDragTargets,
  type DragTargetInfo,
} from "../ipc";
import {
  clearWorkspaceDragPreview,
  reflowActive,
  resolveDropAt,
  updateWorkspaceDragPreview,
} from "./terminal";
import {
  addRestoredWorkspace,
  closePanelLeaf,
  closeTabAndForget,
  dropPanelIntoTarget,
  dropTabIntoTarget,
  moveTab,
  openPanelTab,
  originFromHydrateInfo,
  panelLeafSnapshot,
  removeTabLocal,
  removeWorkspaceLeafLocal,
  solePanelLeafId,
  soleTerminalBackendId,
  useTabs,
  type TabHydrateInfo,
} from "./tabs";
import {
  allocPanelLeafId,
  isPanelLeafId,
  panelTitle,
  type PanelDesc,
  type PanelKind,
} from "./panels";
import {
  collectTerminalLeaves,
  getWorkspace,
  isPanelLeaf,
  makeLeaf,
  makeSplit,
  workspaceOfLeaf,
  type SplitDir,
  type WorkspaceNode,
} from "./workspace";

// The drag module. Every drag in the app — a tab pill, the + button, a pane
// titlebar — shares the same anatomy, and this module owns the shared parts:
//
//  - the floating ghost pill (`dragGhost`, rendered once by DragGhost.vue),
//  - the tab-bar insertion indicator (`barInsertPoint`, rendered by TabBar,
//    placed by its registered resolver),
//  - the workspace split highlight (delegated to state/terminal),
//  - cross-window forwarding: the source window owns all mouse events while
//    the button is held (implicit capture), so a hovered target window never
//    sees the drag — the source hit-tests the cursor against a rect list
//    fetched at drag start and forwards translated positions over Tauri
//    events; the target renders the same affordances locally,
//  - the drop routines: `dropTabOut` (a whole tab leaves this window — same
//    move whether it was grabbed by its tab pill, as a workspace's sole
//    pane, or as a multi-pane workspace's tree via `moveWorkspaceOut`) and
//    `dropLeafOut` (one pane of many moves alone).
//
// What stays in the sources is only what's genuinely different about each
// grip: in-strip carry/reorder physics (TabBar), in-workspace re-tiling
// (TerminalView), spawn-on-landing (the + button).
//
// Cross-window events (all targeted at one specific WebviewWindow, mirroring
// ipc.ts's scoped-listen rationale — a hidden reserve must never react):
//   xdrag:hover {x, y, label}  — cursor at target-client (x, y); label is the
//                                dragged thing's display label for the ghost.
//   xdrag:leave                — cursor left the target (or drag cancelled).
//   xdrag:drop  {x, y, tab_id} — released at (x, y); tab_id is the backend id
//                                about to be attach_tab'd to this window.
//   xdrag:drop_workspace        — a whole multi-pane workspace's tree shape;
//                                see the block comment above `moveWorkspaceOut`.

const MY_LABEL = getCurrentWebviewWindow().label;
const MY_TARGET: TauriEventTarget = { kind: "WebviewWindow", label: MY_LABEL };

function targetOf(label: string): TauriEventTarget {
  return { kind: "WebviewWindow", label };
}

interface CrossHoverPayload {
  x: number;
  y: number;
  label: string;
}

interface CrossDropPayload {
  x: number;
  y: number;
  tab_id: number;
}

/** `xdrag:drop_panel` — a panel pane released over this window. Panels are
 *  frontend-only, so unlike terminals there's no backend to attach: the pane
 *  moves *by value* (its seeds + live title) and is recreated here. */
interface CrossPanelDropPayload {
  x: number;
  y: number;
  desc: PanelDesc;
  title: string;
}

/** A whole multi-pane workspace's tree shape, wire-friendly: split dirs/
 *  ratios are explicit (not resolved from cursor geometry like `xdrag:drop`),
 *  panel leaves carry their desc/title by value, and terminal leaves carry
 *  just their backend id — the target derives their origin from the
 *  `TabHydrateInfo` its own `attach_tab` call delivers. See the
 *  "whole-workspace cross-window moves" block below. */
type WireNode =
  | { kind: "term"; tabId: number; focused: boolean }
  | { kind: "panel"; desc: PanelDesc; title: string; focused: boolean }
  | { kind: "split"; dir: SplitDir; ratio: number; a: WireNode; b: WireNode };

/** `xdrag:drop_workspace` — a whole multi-pane workspace released over this
 *  window. `x`/`y` are null for an append-only drop (tear-off into a new
 *  window, or a fallback attach with no resolved hover point); otherwise
 *  they resolve to a bar slot or a pane split target, same as single-pane
 *  `xdrag:drop` (see `resolveWorkspaceDropPlacement`). */
interface CrossWorkspaceDropPayload {
  x: number | null;
  y: number | null;
  tree: WireNode;
  termIds: number[];
  title: string;
  hostLabel?: string;
  hostId?: number;
  disableSftp?: boolean;
}

// ---- Shared constants ----------------------------------------------------

/** Cursor travel (screen px) before a press becomes a drag. */
export const DRAG_START_PX = 5;

/** Screen px a drag must travel before a release in empty space tears off
 *  into a new window. Drops onto an existing window (its hover preview was
 *  showing) ignore it — the intent there is unambiguous. */
export const DRAG_OUT_THRESHOLD = 200;

/** Cursor within this window's own bounds. While it is, local drag
 *  affordances win and cross-window hover stays off — even if another
 *  window's rect also contains the point (we can't see true z-order, so
 *  "own window first" is the consistent tie-break: mouse events are
 *  flowing to us). */
export function pointInOwnWindow(cx: number, cy: number): boolean {
  return cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight;
}

// ---- Shared affordances ----------------------------------------------------

/** The floating pill following the cursor during any drag — local drags and
 *  foreign (cross-window) hovers alike. Rendered once, by DragGhost.vue. */
export const dragGhost = ref<{ x: number; y: number; label: string } | null>(
  null,
);

/** Cursor position (window-client coords) of any drag that can drop into the
 *  tab bar. TabBar renders the slot insertion indicator off this whenever the
 *  point is inside the bar. */
export const barInsertPoint = ref<{ x: number; y: number } | null>(null);

/** Per-mousemove affordance update shared by every drag source: ghost pill,
 *  workspace split highlight (`draggedId` suppresses self-drops), optionally
 *  the tab-bar insertion point, and cross-window hover forwarding. */
export function dragAffordances(
  e: MouseEvent,
  opts: { label: string; draggedId?: number; barInsert?: boolean },
): void {
  dragGhost.value = { x: e.clientX, y: e.clientY, label: opts.label };
  updateWorkspaceDragPreview(e.clientX, e.clientY, opts.draggedId);
  if (opts.barInsert) barInsertPoint.value = { x: e.clientX, y: e.clientY };
  moveCrossDrag(e.screenX, e.screenY, pointInOwnWindow(e.clientX, e.clientY));
}

/** Drop every local affordance (ghost, bar indicator, split highlight) —
 *  called when a drag pauses them (carried inside the tab strip) or ends. */
export function clearDragAffordances(): void {
  dragGhost.value = null;
  barInsertPoint.value = null;
  clearWorkspaceDragPreview();
}

/** TabBar's hit test for bar-droppable coordinates: null when the point is
 *  outside the tab bar, otherwise the slot the drop would insert before
 *  (null beforeId = append). Registered by the mounted TabBar — module code
 *  can't reach its DOM. */
type BarDropResolver = (x: number, y: number) => { beforeId: number | null } | null;
let barResolver: BarDropResolver | null = null;

export function registerBarDropResolver(fn: BarDropResolver): void {
  barResolver = fn;
}

export function unregisterBarDropResolver(fn: BarDropResolver): void {
  if (barResolver === fn) barResolver = null;
}

/** Where a drop at this client point would land in the tab bar, or null when
 *  it isn't over the bar. */
export function resolveBarDrop(
  x: number,
  y: number,
): { beforeId: number | null } | null {
  return barResolver?.(x, y) ?? null;
}

// ---- Cross-window transport (source side) ---------------------------------

let dragActive = false;
let targets: DragTargetInfo[] = [];
let ghostLabel = "";
/** Window label the cursor currently hovers, or null. */
let hoverLabel: string | null = null;

/** Arm cross-window hover for a drag that just became active. Fetches the
 *  attachable-window rects once — windows don't move mid-drag (the source
 *  window owns the cursor), so a snapshot is enough. */
export async function beginCrossDrag(label: string): Promise<void> {
  dragActive = true;
  ghostLabel = label;
  hoverLabel = null;
  targets = [];
  try {
    const fetched = await windowDragTargets(MY_LABEL);
    // The drag may have ended while the rects were in flight.
    if (dragActive) targets = fetched;
  } catch (err) {
    console.error("window_drag_targets failed:", err);
  }
}

function hitTarget(screenX: number, screenY: number): DragTargetInfo | null {
  // First hit wins — the list is most-recently-focused first, the backend's
  // stand-in for z-order when windows overlap.
  for (const t of targets) {
    if (
      screenX >= t.x &&
      screenX <= t.x + t.w &&
      screenY >= t.y &&
      screenY <= t.y + t.h
    ) {
      return t;
    }
  }
  return null;
}

// Hover emissions are throttled (leading + trailing) — mousemove can fire at
// 120Hz and each emit is an IPC round into the other webview.
const HOVER_EMIT_MS = 16;
let lastEmitAt = 0;
let hoverTimer: number | undefined;
let queuedHover: { label: string; payload: CrossHoverPayload } | null = null;

function flushHover(): void {
  hoverTimer = undefined;
  const q = queuedHover;
  queuedHover = null;
  // Dropped if the cursor already moved on to another window (or left).
  if (!q || q.label !== hoverLabel) return;
  lastEmitAt = performance.now();
  void emitTo(targetOf(q.label), "xdrag:hover", q.payload);
}

function queueHover(label: string, payload: CrossHoverPayload): void {
  queuedHover = { label, payload };
  if (hoverTimer !== undefined) return;
  const wait = Math.max(0, HOVER_EMIT_MS - (performance.now() - lastEmitAt));
  hoverTimer = window.setTimeout(flushHover, wait);
}

function leaveHovered(): void {
  if (hoverLabel == null) return;
  const gone = hoverLabel;
  hoverLabel = null;
  queuedHover = null;
  if (hoverTimer !== undefined) {
    clearTimeout(hoverTimer);
    hoverTimer = undefined;
  }
  void emitTo(targetOf(gone), "xdrag:leave", null);
}

/** Per-mousemove update (folded into `dragAffordances`). `insideOwnWindow`
 *  short-circuits the hit test: inside the source window's own bounds, its
 *  local affordances win. */
export function moveCrossDrag(
  screenX: number,
  screenY: number,
  insideOwnWindow: boolean,
): void {
  if (!dragActive) return;
  const t = insideOwnWindow ? null : hitTarget(screenX, screenY);
  if (!t) {
    leaveHovered();
    return;
  }
  if (hoverLabel !== t.label) {
    leaveHovered();
    hoverLabel = t.label;
  }
  queueHover(t.label, {
    x: screenX - t.content_x,
    y: screenY - t.content_y,
    label: ghostLabel,
  });
}

/** The window under this screen point (if any), with the point translated to
 *  its client coordinates. Pure lookup — commits nothing. */
export function crossDropTargetAt(
  screenX: number,
  screenY: number,
): { label: string; x: number; y: number } | null {
  if (!dragActive) return null;
  const t = hitTarget(screenX, screenY);
  if (!t) return null;
  return {
    label: t.label,
    x: screenX - t.content_x,
    y: screenY - t.content_y,
  };
}

/** Send the drop placement to the target, ahead of the `attach_tab` call —
 *  the target buffers it and applies it when the attach event lands. */
async function commitCrossDrop(
  target: { label: string; x: number; y: number },
  backendTabId: number,
): Promise<void> {
  // The drop supersedes any pending hover/leave for this window.
  hoverLabel = null;
  queuedHover = null;
  await emitTo(targetOf(target.label), "xdrag:drop", {
    x: target.x,
    y: target.y,
    tab_id: backendTabId,
  } satisfies CrossDropPayload);
}

/** End the drag: notify a still-hovered window and drop the rect cache.
 *  Safe to call from every drag-end path, including ones that never began. */
export function endCrossDrag(): void {
  if (!dragActive) return;
  dragActive = false;
  leaveHovered();
  targets = [];
}

// ---- Drop routines ---------------------------------------------------------

/** True when a release at this event should leave the window: it's over
 *  another Prmpt window (its hover preview was showing), or it travelled
 *  past the tear-off threshold from the drag's start. */
export function shouldLeaveWindow(
  e: MouseEvent,
  startScreenX: number,
  startScreenY: number,
): boolean {
  if (
    !pointInOwnWindow(e.clientX, e.clientY) &&
    crossDropTargetAt(e.screenX, e.screenY) != null
  ) {
    return true;
  }
  const dx = e.screenX - startScreenX;
  const dy = e.screenY - startScreenY;
  return dx * dx + dy * dy >= DRAG_OUT_THRESHOLD * DRAG_OUT_THRESHOLD;
}

/** Move a panel pane out of this window: recreate it over there — in the
 *  `cross` window via `xdrag:drop_panel`, or in a fresh panel window — and
 *  close it here. Panels are frontend-only, so unlike terminals nothing is
 *  attached: the pane moves *by value* (seeds + live title). A files panel's
 *  SFTP consumer is released with the local pane and re-acquired by the
 *  recreated one (a brief reconnect when it was the host's last consumer). */
async function movePanelOut(
  slotId: number,
  leafId: number,
  sole: boolean,
  cross: { label: string; x: number; y: number } | null,
): Promise<void> {
  const snap = panelLeafSnapshot(slotId, leafId);
  if (!snap) return;
  if (cross) {
    await emitTo(targetOf(cross.label), "xdrag:drop_panel", {
      x: cross.x,
      y: cross.y,
      desc: snap.desc,
      title: snap.title,
    } satisfies CrossPanelDropPayload);
  } else {
    await openPanelWindow(snap.desc.kind, snap.desc, snap.title);
  }
  if (sole) void closeTabAndForget(slotId);
  else closePanelLeaf(slotId, leafId);
}

// ---- Whole-workspace cross-window moves ------------------------------------
//
// A multi-pane workspace can't move by a single backend id (dropTabOut's
// sole-terminal fast path above) or a single PanelDesc (movePanelOut) — it's
// a tree of several panes. `moveWorkspaceOut` ships the tree's *shape*
// (split dirs/ratios, panel descs, and the backend ids of its terminal
// leaves) over `xdrag:drop_workspace` ahead of a per-leaf `attach_tab` call
// for each terminal id — mirroring `commitCrossDrop`'s "placement before
// attach" ordering, just for N ids instead of one.
//
// The target buffers that shape (`pendingWorkspaceBatches`, keyed by every
// terminal id it names) and intercepts each matching `window:tab_attached`
// via `tryAbsorbIntoWorkspaceBatch` — called from App.vue's onTabAttached
// *before* its normal one-tab-per-attach hydration — rather than letting it
// spawn its own standalone tab. Once every named id has arrived,
// `materializeWorkspaceBatch` assembles the whole tree as one new tab. Panel
// leaves need no attach at all — the shape already carries their desc/title,
// recreated with fresh local ids (leaf ids are only unique within the
// process that allocated them).
//
// A tree with no terminal leaf at all (an all-panel multi-pane workspace)
// isn't covered — `attach_tab`/`tear_off_window` both need at least one
// backend id to learn the target label from. That's a rare shape (a
// workspace built entirely from split panel panes); `dropTabOut` leaves it
// in place rather than moving it partially.

/** Cross-window wire form of a workspace's pane tree — see the block
 *  comment above. `focusedTabId` doesn't survive to the wire (panel leaf
 *  ids are process-local and get replaced on arrival), so the focused leaf
 *  marks itself instead. */
function toWireNode(node: WorkspaceNode, focusedTabId: number): WireNode {
  if (node.kind === "split") {
    return {
      kind: "split",
      dir: node.dir,
      ratio: node.ratio,
      a: toWireNode(node.a, focusedTabId),
      b: toWireNode(node.b, focusedTabId),
    };
  }
  const focused = node.tabId === focusedTabId;
  return isPanelLeaf(node)
    ? {
        kind: "panel",
        desc: { ...node.origin.panel! },
        title: node.origin.title,
        focused,
      }
    : { kind: "term", tabId: node.tabId, focused };
}

function wireTermIds(node: WireNode, out: number[] = []): number[] {
  if (node.kind === "split") {
    wireTermIds(node.a, out);
    wireTermIds(node.b, out);
  } else if (node.kind === "term") {
    out.push(node.tabId);
  }
  return out;
}

/** The multi-pane counterpart of `dropTabOut`'s sole-terminal/sole-panel
 *  fast paths: moves a whole split tree to the window under the cursor, or
 *  tears it off into a new one. Returns false for an all-panel tree (see
 *  the block comment above) — the caller leaves it in place rather than
 *  moving it partially. */
async function moveWorkspaceOut(
  slotId: number,
  cross: { label: string; x: number; y: number } | null,
  screenX: number,
  screenY: number,
): Promise<boolean> {
  const ws = getWorkspace(slotId);
  if (!ws || collectTerminalLeaves(ws.root).length === 0) return false;

  const wire = toWireNode(ws.root, ws.focusedTabId);
  const termIds = wireTermIds(wire);
  const tab = useTabs().tabs.value.find((t) => t.id === slotId);

  let target = cross;
  if (!target) {
    const label = await windowAtScreenPoint(screenX, screenY, MY_LABEL);
    target = label ? { label, x: -1, y: -1 } : null;
  }
  if (!target) {
    // Cursor in CSS pixels (matches Tauri logical units). innerWidth/
    // innerHeight rather than outer* — WKWebView often reports zero for
    // outer*, which would yield a 0x0 window.
    const width = Math.max(400, window.innerWidth);
    const height = Math.max(300, window.innerHeight);
    const label = await tearOffWindow({ screenX, screenY, width, height });
    target = { label, x: -1, y: -1 };
  }

  // Sent (and awaited) before any attach_tab call below, same ordering
  // `commitCrossDrop` relies on: the target must know this batch exists
  // before the first matching window:tab_attached lands.
  await emitTo(targetOf(target.label), "xdrag:drop_workspace", {
    x: cross ? target.x : null,
    y: cross ? target.y : null,
    tree: wire,
    termIds,
    title: tab?.title ?? "Terminal",
    hostLabel: tab?.hostLabel,
    hostId: tab?.hostId,
    disableSftp: tab?.disableSftp,
  } satisfies CrossWorkspaceDropPayload);

  for (const id of termIds) await attachTab(id, target.label);

  removeTabLocal(slotId);
  return true;
}

/** The shared end-of-drag routine for a whole tab leaving this window — tab
 *  drags, + -button drags, and a workspace's sole pane dragged by its
 *  titlebar (same tab, different handle). A single-terminal tab attaches its
 *  backend to the window under the cursor (sending the drop placement its
 *  hover preview promised) or tears off into a fresh window sized like this
 *  one; a panel-only tab moves by value the same way; a multi-pane tab with
 *  at least one terminal leaf moves as a whole tree via `moveWorkspaceOut`.
 *  Removes the tab locally on success and always ends the cross-drag state. */
export async function dropTabOut(
  slotId: number,
  screenX: number,
  screenY: number,
): Promise<void> {
  // Resolved from the drag's focus-ordered rect cache before endCrossDrag()
  // below drops it; for terminals the backend hit-test is the fallback for
  // drags that never armed hover (e.g. begun before the rect fetch resolved).
  const cross = crossDropTargetAt(screenX, screenY);
  try {
    // `slotId` is the frontend slot id; the backend tear-off/attach commands
    // key on the backend PTY id, which lives on the tab's sole terminal leaf.
    const backendId = soleTerminalBackendId(slotId);
    if (backendId == null) {
      // Panel-only tab: no backend to attach — move the panel by value.
      const leafId = solePanelLeafId(slotId);
      if (leafId != null) {
        await movePanelOut(slotId, leafId, true, cross);
      } else if (!(await moveWorkspaceOut(slotId, cross, screenX, screenY))) {
        return; // all-panel multi-pane tree — not yet supported, leave in place
      }
    } else {
      const target =
        cross?.label ?? (await windowAtScreenPoint(screenX, screenY, MY_LABEL));
      if (target) {
        if (cross) await commitCrossDrop(cross, backendId);
        await attachTab(backendId, target);
      } else {
        // Cursor in CSS pixels (matches Tauri logical units). innerWidth/
        // innerHeight rather than outer* — WKWebView often reports zero for
        // outer*, which would yield a 0x0 window.
        const width = Math.max(400, window.innerWidth);
        const height = Math.max(300, window.innerHeight);
        await tearOffTab({ tabId: backendId, screenX, screenY, width, height });
      }
      removeTabLocal(slotId);
    }
    // Tearing off the last tab closes the source window — same rule as the
    // exit path. Otherwise we'd leave an empty shell.
    const { tabs } = useTabs();
    if (!tabs.value.some((t) => t.kind !== "home")) void closeCurrentWindow();
  } catch (err) {
    console.error("drag-out failed:", err);
  } finally {
    endCrossDrag();
  }
}

/** Drop a *new*, unseeded panel that left the window (a + menu option
 *  dragged out): recreate it in the window under the cursor, or in a fresh
 *  panel window. The panel-by-value counterpart of the + button's terminal
 *  path (spawn, then `dropTabOut`). Ends the cross-drag state. */
export function dropNewPanelOut(
  kind: PanelKind,
  screenX: number,
  screenY: number,
): void {
  const cross = crossDropTargetAt(screenX, screenY);
  void (async () => {
    try {
      if (cross) {
        await emitTo(targetOf(cross.label), "xdrag:drop_panel", {
          x: cross.x,
          y: cross.y,
          desc: { kind },
          title: panelTitle({ kind }),
        } satisfies CrossPanelDropPayload);
      } else {
        await openPanelWindow(kind);
      }
    } catch (err) {
      console.error("panel drag-out failed:", err);
    } finally {
      endCrossDrag();
    }
  })();
}

/** Move one pane of a multi-pane workspace out of this window — the
 *  pane-titlebar counterpart of `dropTabOut`/`moveWorkspaceOut`, called once
 *  the cursor has left this window's own bounds. Terminal panes go by
 *  backend id: placement first (bar slot / split, resolved by the target
 *  from the drop point) when there's a live hover target, then attach to the
 *  window under the cursor or tear off into a fresh one, then prune the leaf
 *  locally — the backend keeps running throughout. Panel panes move by value
 *  (`movePanelOut`, which already opens a fresh panel window itself when
 *  there's no hover target). */
export function dropLeafOut(
  slotId: number,
  tabId: number,
  screenX: number,
  screenY: number,
): void {
  const cross = crossDropTargetAt(screenX, screenY);
  void (async () => {
    try {
      if (isPanelLeafId(tabId)) {
        await movePanelOut(slotId, tabId, false, cross);
      } else {
        const target =
          cross?.label ?? (await windowAtScreenPoint(screenX, screenY, MY_LABEL));
        if (target) {
          if (cross) await commitCrossDrop(cross, tabId);
          await attachTab(tabId, target);
        } else {
          const width = Math.max(400, window.innerWidth);
          const height = Math.max(300, window.innerHeight);
          const label = await tearOffWindow({ screenX, screenY, width, height });
          await attachTab(tabId, label);
        }
        removeWorkspaceLeafLocal(slotId, tabId);
      }
    } catch (err) {
      console.error("cross-window pane drop failed:", err);
    } finally {
      endCrossDrag();
    }
  })();
}

// ---- Cross-window transport (target side) ----------------------------------

/** Placements resolved from an `xdrag:drop`, keyed by backend tab id, waiting
 *  for the matching `window:tab_attached`. TTL'd so an attach that never
 *  arrives (source-side failure) can't replay onto an unrelated future tab. */
const pendingPlacements = new Map<
  number,
  { at: number; apply: (slotId: number) => void }
>();
const PLACEMENT_TTL_MS = 5000;

function onForeignHover(p: CrossHoverPayload): void {
  dragGhost.value = { x: p.x, y: p.y, label: p.label };
  barInsertPoint.value = { x: p.x, y: p.y };
  // Over the tab bar the insertion indicator is the affordance; anywhere
  // else, the same workspace split highlight local drags show.
  if (barResolver?.(p.x, p.y)) clearWorkspaceDragPreview();
  else updateWorkspaceDragPreview(p.x, p.y);
}

function onForeignDrop(p: CrossDropPayload): void {
  clearDragAffordances();
  const bar = barResolver?.(p.x, p.y);
  let apply: ((slotId: number) => void) | null = null;
  if (bar) {
    const beforeId = bar.beforeId;
    apply = (slotId) => moveTab(slotId, beforeId);
  } else {
    // Resolve against the workspace *now*, before the attach makes the new
    // tab active (resolveDropAt works on the active tab).
    const res = resolveDropAt(p.x, p.y);
    if (res) {
      apply = (slotId) =>
        void dropTabIntoTarget(
          slotId,
          res.slotId,
          res.targetPaneTabId,
          res.dir,
          res.placeDraggedFirst,
        );
    }
  }
  if (!apply) return; // plain attach — appended tab is already right
  pendingPlacements.set(p.tab_id, { at: performance.now(), apply });
  // The attach event normally lands after the drop, but nothing guarantees
  // it: if the tab is already here, place it now.
  if (workspaceOfLeaf(p.tab_id) !== undefined) consumeCrossDropPlacement(p.tab_id);
}

/** A panel pane arriving from another window. No attach round-trip: the
 *  placement resolves and applies immediately — split into the workspace at
 *  the drop point, into the bar at the indicated slot, or (dead space —
 *  titlebar etc.) appended as a new tab. */
function onForeignPanelDrop(p: CrossPanelDropPayload): void {
  clearDragAffordances();
  const bar = barResolver?.(p.x, p.y);
  if (!bar) {
    const res = resolveDropAt(p.x, p.y);
    if (res) {
      dropPanelIntoTarget(
        p.desc,
        res.slotId,
        res.targetPaneTabId,
        res.dir,
        res.placeDraggedFirst,
        p.title,
      );
      return;
    }
  }
  const slotId = openPanelTab(p.desc, p.title);
  if (bar) moveTab(slotId, bar.beforeId);
}

/** A whole multi-pane workspace's shape, buffered here (keyed by every
 *  terminal id it names) until each one's `window:tab_attached` has landed —
 *  see the "whole-workspace cross-window moves" block comment above
 *  `moveWorkspaceOut`. TTL'd like `pendingPlacements`, just longer: this
 *  waits on N sequential attach_tab round-trips, not one. */
interface PendingWorkspaceBatch {
  at: number;
  payload: CrossWorkspaceDropPayload;
  attached: Map<number, TabHydrateInfo>;
  apply: ((slotId: number) => void) | null;
}
const pendingWorkspaceBatches = new Map<number, PendingWorkspaceBatch>();
const WORKSPACE_BATCH_TTL_MS = 8000;

/** Where a whole-workspace drop lands: a bar slot, or split into the pane
 *  under the drop point — the same two placements `onForeignDrop` resolves
 *  for a single-pane attach, reused here via `dropTabIntoTarget` (which
 *  already grafts a whole tree, not just a single leaf). Resolved *now*,
 *  before the batch's tree is even assembled, for the same reason
 *  `onForeignDrop` resolves early: `resolveDropAt` reads the currently
 *  active tab, which is what the drop's hover preview was actually shown
 *  against. Null for dead space (no bar, no pane hit) or an append-only
 *  drop (tear-off, or a fallback attach with no resolved hover point) —
 *  the assembled tree is then just appended as a new tab. */
function resolveWorkspaceDropPlacement(
  p: CrossWorkspaceDropPayload,
): ((slotId: number) => void) | null {
  if (p.x == null || p.y == null) return null;
  const bar = barResolver?.(p.x, p.y);
  if (bar) {
    const beforeId = bar.beforeId;
    return (slotId) => moveTab(slotId, beforeId);
  }
  const res = resolveDropAt(p.x, p.y);
  if (!res) return null;
  return (slotId) =>
    void dropTabIntoTarget(
      slotId,
      res.slotId,
      res.targetPaneTabId,
      res.dir,
      res.placeDraggedFirst,
    );
}

function onForeignWorkspaceDrop(p: CrossWorkspaceDropPayload): void {
  clearDragAffordances();
  const batch: PendingWorkspaceBatch = {
    at: performance.now(),
    payload: p,
    attached: new Map(),
    apply: resolveWorkspaceDropPlacement(p),
  };
  for (const id of p.termIds) pendingWorkspaceBatches.set(id, batch);
}

/** Rebuild a workspace tree from its wire shape, resolving each terminal
 *  leaf's origin from the `TabHydrateInfo` its attach delivered and
 *  allocating a fresh local id for each panel leaf. Tracks the id marked
 *  `focused` in the wire tree as it goes (leaf ids are reassigned for
 *  panels, so the wire can't just carry the original focused id). */
function buildWorkspaceFromWire(
  node: WireNode,
  attached: Map<number, TabHydrateInfo>,
  focusRef: { id: number },
): WorkspaceNode {
  if (node.kind === "split") {
    return makeSplit(
      node.dir,
      buildWorkspaceFromWire(node.a, attached, focusRef),
      buildWorkspaceFromWire(node.b, attached, focusRef),
      node.ratio,
    );
  }
  const leaf =
    node.kind === "panel"
      ? makeLeaf(allocPanelLeafId(), {
          kind: "panel",
          title: node.title,
          panel: node.desc,
        })
      : makeLeaf(node.tabId, originFromHydrateInfo(attached.get(node.tabId)!));
  if (node.focused) focusRef.id = leaf.tabId;
  return leaf;
}

function materializeWorkspaceBatch(batch: PendingWorkspaceBatch): void {
  const p = batch.payload;
  const focusRef = { id: -1 };
  const root = buildWorkspaceFromWire(p.tree, batch.attached, focusRef);
  // Assembled as its own tab first (mirrors the single-pane path, which
  // always attaches as a standalone tab before `dropTabIntoTarget` grafts
  // and consumes it) — `apply` then either reorders it in the bar, splits
  // it into a pane (consuming this tab into the target's tree), or is null
  // and it just stays as the new tab it already is.
  const slotId = addRestoredWorkspace(p.title, root, focusRef.id, {
    hostLabel: p.hostLabel,
    hostId: p.hostId,
    disableSftp: p.disableSftp,
  });
  batch.apply?.(slotId);
  // The panes were sized for the source window; re-tile/resize them (and
  // their backend PTYs) to this one's geometry, same as a plain attach.
  reflowActive(useTabs().active.value);
}

/** Intercept a `window:tab_attached` event for a leaf that's part of a
 *  pending whole-workspace batch — called from App.vue's onTabAttached
 *  *before* its normal attachTabLocal hydration. Returns true once absorbed
 *  (the caller must skip normal hydration for it); assembles the whole tree
 *  into one new tab once every leaf named in the batch has arrived. */
export function tryAbsorbIntoWorkspaceBatch(info: TabHydrateInfo): boolean {
  const batch = pendingWorkspaceBatches.get(info.id);
  if (!batch) return false;
  if (performance.now() - batch.at > WORKSPACE_BATCH_TTL_MS) {
    for (const id of batch.payload.termIds) pendingWorkspaceBatches.delete(id);
    return false;
  }
  batch.attached.set(info.id, info);
  if (batch.attached.size === batch.payload.termIds.length) {
    for (const id of batch.payload.termIds) pendingWorkspaceBatches.delete(id);
    materializeWorkspaceBatch(batch);
  }
  return true;
}

/** Apply a buffered drop placement to a freshly-attached tab. Called from the
 *  `window:tab_attached` handler with the backend tab id it carried; a no-op
 *  for ordinary (non-cross-drag) attaches. */
export function consumeCrossDropPlacement(backendTabId: number): void {
  const pending = pendingPlacements.get(backendTabId);
  if (!pending) return;
  pendingPlacements.delete(backendTabId);
  if (performance.now() - pending.at > PLACEMENT_TTL_MS) return;
  const slotId = workspaceOfLeaf(backendTabId);
  if (slotId === undefined) return;
  pending.apply(slotId);
}

/** Install this window's receiving side. Returns the unlisteners for App.vue's
 *  HMR-safe teardown list. */
export async function installCrossDragTarget(): Promise<UnlistenFn[]> {
  return await Promise.all([
    listen<CrossHoverPayload>("xdrag:hover", (e) => onForeignHover(e.payload), {
      target: MY_TARGET,
    }),
    listen<null>("xdrag:leave", () => clearDragAffordances(), {
      target: MY_TARGET,
    }),
    listen<CrossDropPayload>("xdrag:drop", (e) => onForeignDrop(e.payload), {
      target: MY_TARGET,
    }),
    listen<CrossPanelDropPayload>(
      "xdrag:drop_panel",
      (e) => onForeignPanelDrop(e.payload),
      { target: MY_TARGET },
    ),
    listen<CrossWorkspaceDropPayload>(
      "xdrag:drop_workspace",
      (e) => onForeignWorkspaceDrop(e.payload),
      { target: MY_TARGET },
    ),
  ]);
}
