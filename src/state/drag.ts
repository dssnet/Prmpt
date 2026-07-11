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
  windowAtScreenPoint,
  windowDragTargets,
  type DragTargetInfo,
} from "../ipc";
import {
  clearWorkspaceDragPreview,
  resolveDropAt,
  updateWorkspaceDragPreview,
} from "./terminal";
import {
  closePanelLeaf,
  closeTabAndForget,
  dropPanelIntoTarget,
  dropTabIntoTarget,
  moveTab,
  openPanelTab,
  panelLeafSnapshot,
  removeTabLocal,
  removeWorkspaceLeafLocal,
  solePanelLeafId,
  soleTerminalBackendId,
  useTabs,
} from "./tabs";
import {
  isPanelLeafId,
  panelTitle,
  type PanelDesc,
  type PanelKind,
} from "./panels";
import { workspaceOfLeaf } from "./workspace";

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
//    move whether it was grabbed by its tab pill or as a workspace's sole
//    pane) and `dropLeafOut` (one pane of many moves alone).
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

/** The shared end-of-drag routine for a whole tab leaving this window — tab
 *  drags, + -button drags, and a workspace's sole pane dragged by its
 *  titlebar (same tab, different handle). A terminal tab attaches its backend
 *  to the window under the cursor (sending the drop placement its hover
 *  preview promised) or tears off into a fresh window sized like this one; a
 *  panel-only tab moves by value the same way. Removes the tab locally on
 *  success and always ends the cross-drag state. */
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
      if (leafId == null) return; // multi-pane tree — can't move whole
      await movePanelOut(slotId, leafId, true, cross);
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

/** Move one pane of a multi-pane workspace to the window under the cursor.
 *  Terminal panes go by backend id: placement first (bar slot / split,
 *  resolved by the target from the drop point), then attach, then prune the
 *  leaf locally — the backend keeps running throughout. Panel panes move by
 *  value (`movePanelOut`). Returns false when the cursor wasn't over another
 *  window (the caller falls back to its local handling). */
export function dropLeafOut(
  slotId: number,
  tabId: number,
  screenX: number,
  screenY: number,
): boolean {
  const cross = crossDropTargetAt(screenX, screenY);
  if (!cross) return false;
  void (async () => {
    try {
      if (isPanelLeafId(tabId)) {
        await movePanelOut(slotId, tabId, false, cross);
      } else {
        await commitCrossDrop(cross, tabId);
        await attachTab(tabId, cross.label);
        removeWorkspaceLeafLocal(slotId, tabId);
      }
    } catch (err) {
      console.error("cross-window pane drop failed:", err);
    } finally {
      endCrossDrag();
    }
  })();
  return true;
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
  ]);
}
