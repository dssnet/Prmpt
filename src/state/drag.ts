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
  dropPanelIntoTarget,
  dropTabIntoTarget,
  metaFromHydrateInfo,
  moveTab,
  openPanelTab,
  originFromHydrateInfo,
  removeTabLocal,
  removeWorkspaceLeafLocal,
  useTabs,
  type TabHydrateInfo,
} from "./tabs";
import {
  allocPanelLeafId,
  panelTitle,
  type PanelDesc,
  type PanelKind,
} from "./panels";
import { showToast } from "./toasts";
import {
  findLeafByTabId,
  getWorkspace,
  isPanelLeaf,
  makeLeaf,
  makeSplit,
  type SplitDir,
  type WorkspaceNode,
} from "./workspace";

// The drag module. Every drag in the app — a tab pill, the + button, a pane
// titlebar — shares the same anatomy, and this module owns all of it:
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
//  - placement resolution (`resolvePlacement`/`applyTabPlacement`): bar-slot
//    vs split-into-a-pane vs plain-append, one implementation shared by
//    local drops (`commitLocalTabDrop`/`commitLocalPanelDrop`) and
//    cross-window drops alike — see the block comment above them,
//  - the single move-out primitive (`moveOut`): every drag source first
//    normalizes what it's moving into a `MoveSource` — a wire-ready pane
//    tree, plus (for a whole tab) its TabState-level metadata — then hands
//    it to `moveOut`, which resolves the destination (attach to the window
//    under the cursor, or tear off into a fresh one) and ships it. A tab
//    pill, a pane's own titlebar, and a freshly-spawned "+" button panel are
//    all just different ways of building a `MoveSource`; the move itself
//    doesn't know or care which. See the block comment above `MoveSource`.
//
// What stays in the sources is only what's genuinely different about each
// grip: in-strip carry/reorder physics (TabBar), in-workspace re-tiling
// (TerminalView), spawn-on-landing (the + button, and — for a terminal — a
// backend spawn before it can become a MoveSource at all: App.vue spawns the
// PTY, which creates a real one-pane tab, then hands its slot id to
// `moveTabOut` the same as a tab-pill drag would).
//
// Cross-window events (all targeted at one specific WebviewWindow, mirroring
// ipc.ts's scoped-listen rationale — a hidden reserve must never react):
//   xdrag:hover {x, y, label} — cursor at target-client (x, y); label is the
//                               dragged thing's display label for the ghost.
//   xdrag:leave               — cursor left the target (or drag cancelled).
//   xdrag:drop_tree {..}      — a MoveSource landed here: wire tree, the
//                               backend ids it names (0, 1, or N), optional
//                               whole-tab metadata, and a resolved drop
//                               point. See the block comment above
//                               `pendingMoveBatches`.

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

/** TabState-level fields that only apply when a `MoveSource` is a whole tab
 *  (not a lone pane peeled off a still-live workspace) — SSH host identity
 *  rides on the tab, not on any one leaf's `TabOrigin`. */
interface WholeTabMeta {
  title: string;
  hostLabel?: string;
  hostId?: number;
  disableSftp?: boolean;
}

/** Cross-window wire form of a pane tree: split dirs/ratios are explicit
 *  (not resolved from cursor geometry), panel leaves carry their desc/title
 *  by value, and terminal leaves carry just their backend id — the target
 *  derives their origin from the `TabHydrateInfo` its own `attach_tab` call
 *  delivers. See the `MoveSource` block comment below. */
type WireNode =
  | { kind: "term"; tabId: number; focused: boolean }
  | { kind: "panel"; desc: PanelDesc; title: string; focused: boolean }
  | { kind: "split"; dir: SplitDir; ratio: number; a: WireNode; b: WireNode };

/** `xdrag:drop_tree` — a `MoveSource` released over this window. `x`/`y` are
 *  null for an append-only drop (tear-off into a new window, or a fallback
 *  attach with no resolved hover point); otherwise they resolve to a bar
 *  slot or a pane split target via `resolvePlacement`, same as a local
 *  drop. */
interface CrossTreeDropPayload {
  x: number | null;
  y: number | null;
  tree: WireNode;
  termIds: number[];
  whole?: WholeTabMeta;
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

/** End the drag: notify a still-hovered window and drop the rect cache.
 *  Safe to call from every drag-end path, including ones that never began. */
export function endCrossDrag(): void {
  if (!dragActive) return;
  dragActive = false;
  leaveHovered();
  targets = [];
}

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

// ---- Wire tree helpers ------------------------------------------------------

/** `focusedTabId` doesn't survive to the wire (panel leaf ids are
 *  process-local and get replaced on arrival), so the focused leaf marks
 *  itself instead. */
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

// ---- Move sources -----------------------------------------------------------
//
// Everything draggable out of a window — a whole tab (grabbed by its tab
// pill, or by a workspace's sole pane), one pane of a still-live multi-pane
// workspace (grabbed by its own titlebar), or a freshly-spawned, not-yet-
// placed panel (the "+" button) — normalizes to the same `MoveSource`: a
// wire-ready pane tree (0, 1, or N terminal leaves — a lone pane and a
// 5-way split are the same shape, just a different leaf count) plus,
// *only* when the whole source tab is moving, its TabState-level metadata.
// `moveOut` below is the one function that knows how to move any of them.
//
// A tree with no terminal leaf at all (an all-panel multi-pane workspace)
// can still be *shipped* to an existing window here (nothing about that
// needs a backend id), but can't safely tear off into a genuinely new one —
// `attach_tab` registers a moved terminal's backend id in the Rust tab
// registry, which is what lets a cold-starting window recover a lost
// `xdrag:drop_tree` emit via its own boot-time query; a pure panel payload
// has no such id and thus no safety net. `TabBar.vue`'s `tabIsAllPanel`
// guard keeps that shape from reaching `moveOut` via tear-off at all.

interface MoveSource {
  tree: WireNode;
  /** Backend ids of every terminal leaf in `tree` — 0 (pure panel tree), 1,
   *  or N. Order doesn't matter; the target buffers by id, not arrival
   *  order. */
  termIds: number[];
  /** Present only when the whole source tab is moving — the target then
   *  wraps the assembled tree in a new tab carrying these fields. Absent
   *  for a lone leaf peeled off a still-live workspace: the target instead
   *  derives them from that leaf's own `TabHydrateInfo` (terminal) or wire
   *  title (panel) at materialize time. */
  whole?: WholeTabMeta;
  /** Run once after the move fully commits on the source side (after every
   *  termId attached and the wire payload sent) — prunes local state
   *  without touching any backend (ownership already transferred). Never
   *  run if `moveOut` throws. */
  cleanupSource: () => void;
}

/** Tab pill drag, or a titlebar drag of a workspace's sole pane (same tab,
 *  different handle). Null if the tab/workspace vanished from under the
 *  drag (defensive — always run `endCrossDrag()` if this returns null). */
function buildTabMoveSource(slotId: number): MoveSource | null {
  const ws = getWorkspace(slotId);
  const tab = useTabs().tabs.value.find((t) => t.id === slotId);
  if (!ws || !tab) return null;
  const tree = toWireNode(ws.root, ws.focusedTabId);
  return {
    tree,
    termIds: wireTermIds(tree),
    whole: {
      title: tab.title,
      hostLabel: tab.hostLabel,
      hostId: tab.hostId,
      disableSftp: tab.disableSftp,
    },
    cleanupSource: () => removeTabLocal(slotId),
  };
}

/** One pane of a multi-pane workspace, dragged out by its own titlebar. */
function buildLeafMoveSource(slotId: number, tabId: number): MoveSource | null {
  const ws = getWorkspace(slotId);
  const leaf = ws ? findLeafByTabId(ws.root, tabId) : null;
  if (!leaf) return null;
  const tree = toWireNode(leaf, tabId);
  return {
    tree,
    termIds: wireTermIds(tree),
    cleanupSource: () => removeWorkspaceLeafLocal(slotId, tabId),
  };
}

/** A freshly-spawned, not-yet-attached-anywhere panel (the "+" button
 *  dragged out). Nothing local was ever created, so cleanup is a no-op. A
 *  terminal "+"-button drag needs no equivalent — App.vue spawns the
 *  backend first (a real one-pane tab), then calls `moveTabOut`. */
function buildNewPanelMoveSource(kind: PanelKind): MoveSource {
  const desc: PanelDesc = { kind };
  return {
    tree: { kind: "panel", desc, title: panelTitle(desc), focused: true },
    termIds: [],
    cleanupSource: () => {},
  };
}

// ---- The move-out primitive -------------------------------------------------

async function resolveHitTestTarget(
  screenX: number,
  screenY: number,
): Promise<{ label: string; x: number; y: number } | null> {
  const label = await windowAtScreenPoint(screenX, screenY, MY_LABEL);
  return label ? { label, x: -1, y: -1 } : null;
}

/** Ship a `MoveSource` to an already-known window: the wire payload first,
 *  awaited before any `attach_tab` call — mirrors the ordering the old
 *  single-pane path documented as `commitCrossDrop`: the target must know
 *  this payload exists before the first matching `window:tab_attached`
 *  lands, since Tauri delivers events to a given target in the order this
 *  window issued them. Then attach every terminal leaf's backend (0, 1, or
 *  N — same loop either way). */
async function shipTo(
  label: string,
  x: number | null,
  y: number | null,
  source: MoveSource,
): Promise<void> {
  await emitTo(targetOf(label), "xdrag:drop_tree", {
    x,
    y,
    tree: source.tree,
    termIds: source.termIds,
    whole: source.whole,
  } satisfies CrossTreeDropPayload);
  for (const id of source.termIds) await attachTab(id, label);
}

/** The one "move a subtree out of this window" primitive — every drag
 *  source builds a `MoveSource` (see the block comment above) and calls
 *  this. Resolves the destination — the window under a live cross-window
 *  hover, else the window under the cursor, else a freshly torn-off one —
 *  ships the payload, then prunes the source. Toasts and leaves source
 *  state untouched on any failure (so a failed drag doesn't silently lose
 *  panes). Always ends cross-drag state. */
export async function moveOut(
  source: MoveSource,
  screenX: number,
  screenY: number,
): Promise<void> {
  const cross = crossDropTargetAt(screenX, screenY);
  try {
    // The drop supersedes any pending hover/leave for this window.
    hoverLabel = null;
    queuedHover = null;
    const target = cross ?? (await resolveHitTestTarget(screenX, screenY));
    if (target) {
      await shipTo(target.label, cross ? target.x : null, cross ? target.y : null, source);
    } else if (source.termIds.length === 0 && source.tree.kind === "panel") {
      // No backend id anywhere in this tree ⇒ no registry-side recovery if
      // a brand-new window's listener loses the boot race (see the
      // block comment above `MoveSource`) — reuse the mechanism built for
      // exactly that single-panel case.
      await openPanelWindow(source.tree.desc.kind, source.tree.desc, source.tree.title);
    } else {
      // Cursor in CSS pixels (matches Tauri logical units). innerWidth/
      // innerHeight rather than outer* — WKWebView often reports zero for
      // outer*, which would yield a 0x0 window.
      const width = Math.max(400, window.innerWidth);
      const height = Math.max(300, window.innerHeight);
      const label = await tearOffWindow({ screenX, screenY, width, height });
      await shipTo(label, null, null, source);
    }
    source.cleanupSource();
    // Tearing off the last tab closes the source window — same rule as the
    // exit path. Otherwise we'd leave an empty shell.
    const { tabs } = useTabs();
    if (!tabs.value.some((t) => t.kind !== "home")) void closeCurrentWindow();
  } catch (err) {
    console.error("move-out failed:", err);
    showToast({
      host: "Local",
      title: "Move failed",
      detail: err instanceof Error ? err.message : String(err),
      kind: "error",
    });
  } finally {
    endCrossDrag();
  }
}

/** Whole tab leaves this window — tab pill drags, "+"-button terminal
 *  spawn-outs (after the backend is spawned), and a workspace's sole pane
 *  dragged by its titlebar (same tab, different handle). */
export async function moveTabOut(
  slotId: number,
  screenX: number,
  screenY: number,
): Promise<void> {
  const source = buildTabMoveSource(slotId);
  if (!source) {
    endCrossDrag();
    return;
  }
  await moveOut(source, screenX, screenY);
}

/** One pane of a multi-pane workspace leaves this window, dragged by its
 *  own titlebar. */
export function moveLeafOut(
  slotId: number,
  tabId: number,
  screenX: number,
  screenY: number,
): void {
  const source = buildLeafMoveSource(slotId, tabId);
  if (!source) {
    endCrossDrag();
    return;
  }
  void moveOut(source, screenX, screenY);
}

/** A fresh, unseeded panel ("+" button, or its right-click menu) leaves
 *  this window. */
export function moveNewPanelOut(
  kind: PanelKind,
  screenX: number,
  screenY: number,
): void {
  void moveOut(buildNewPanelMoveSource(kind), screenX, screenY);
}

// ---- Placement resolution (shared by local and cross-window drops) --------

type DropPlacement =
  | { kind: "bar"; beforeId: number | null }
  | {
      kind: "pane";
      slotId: number;
      targetPaneTabId: number;
      dir: SplitDir;
      placeDraggedFirst: boolean;
    };

/** The one bar-or-pane-or-null resolver: a tab-bar slot, a split target
 *  inside the active workspace (`resolveDropAt`, the DOM-coupled hit test
 *  that genuinely belongs in terminal.ts), or neither. Shared by local
 *  drops (`commitLocalTabDrop`/`commitLocalPanelDrop` below) and
 *  cross-window drops (`onForeignTreeDrop`). */
function resolvePlacement(
  x: number,
  y: number,
  draggedId?: number,
): DropPlacement | null {
  const bar = barResolver?.(x, y);
  if (bar) return { kind: "bar", beforeId: bar.beforeId };
  const pane = resolveDropAt(x, y, draggedId);
  return pane
    ? {
        kind: "pane",
        slotId: pane.slotId,
        targetPaneTabId: pane.targetPaneTabId,
        dir: pane.dir,
        placeDraggedFirst: pane.placeDraggedFirst,
      }
    : null;
}

/** Apply a resolved placement to a tab that already exists locally —
 *  reorder it in the bar, or graft its whole tree (one leaf or many, same
 *  either way) into the target pane, consuming it. No-op for a null
 *  placement (plain-append — the tab is already right where it landed). */
function applyTabPlacement(slotId: number, placement: DropPlacement | null): void {
  if (!placement) return;
  if (placement.kind === "bar") {
    moveTab(slotId, placement.beforeId);
    return;
  }
  void dropTabIntoTarget(
    slotId,
    placement.slotId,
    placement.targetPaneTabId,
    placement.dir,
    placement.placeDraggedFirst,
  );
}

/** Drop a whole *existing* local tab at this client point: a bar reorder or
 *  a split into the pane under it. Returns true if it landed in a
 *  workspace (caller should then skip tear-off). */
export function commitLocalTabDrop(
  draggedId: number,
  clientX: number,
  clientY: number,
): boolean {
  const placement = resolvePlacement(clientX, clientY, draggedId);
  clearWorkspaceDragPreview();
  if (!placement) return false;
  applyTabPlacement(draggedId, placement);
  return true;
}

/** Like `commitLocalTabDrop`, but drops a *new* panel (file browser / git)
 *  at this client point instead of an existing tab — for a "+" menu option
 *  dragged onto the terminal area or tab bar locally. Returns true if it
 *  landed somewhere. */
export function commitLocalPanelDrop(
  kind: PanelKind,
  clientX: number,
  clientY: number,
): boolean {
  const placement = resolvePlacement(clientX, clientY);
  clearWorkspaceDragPreview();
  if (!placement) return false;
  if (placement.kind === "bar") {
    moveTab(openPanelTab({ kind }), placement.beforeId);
  } else {
    void dropPanelIntoTarget(
      { kind },
      placement.slotId,
      placement.targetPaneTabId,
      placement.dir,
      placement.placeDraggedFirst,
    );
  }
  return true;
}

// ---- Cross-window transport (target side) ----------------------------------

function onForeignHover(p: CrossHoverPayload): void {
  dragGhost.value = { x: p.x, y: p.y, label: p.label };
  barInsertPoint.value = { x: p.x, y: p.y };
  // Over the tab bar the insertion indicator is the affordance; anywhere
  // else, the same workspace split highlight local drags show.
  if (barResolver?.(p.x, p.y)) clearWorkspaceDragPreview();
  else updateWorkspaceDragPreview(p.x, p.y);
}

/** A `MoveSource`'s wire payload, buffered here (keyed by every terminal id
 *  it names) until each one's `window:tab_attached` has landed. A pure
 *  panel tree (`termIds.length === 0`) never registers a batch — there's
 *  nothing to wait for, so it materializes immediately in
 *  `onForeignTreeDrop` itself. N=1 is just "the batch happens to need
 *  exactly one id" — no separate fast path. TTL'd so an attach that never
 *  arrives (source-side failure) can't replay onto an unrelated future
 *  tab. */
interface PendingMoveBatch {
  at: number;
  payload: CrossTreeDropPayload;
  attached: Map<number, TabHydrateInfo>;
  placement: DropPlacement | null;
}
const pendingMoveBatches = new Map<number, PendingMoveBatch>();
const MOVE_BATCH_TTL_MS = 8000;

function onForeignTreeDrop(p: CrossTreeDropPayload): void {
  clearDragAffordances();
  // Resolved *now*, before the tree is even assembled: `resolveDropAt`
  // reads the currently active tab, which is what the drop's hover preview
  // was actually shown against.
  const placement = p.x != null && p.y != null ? resolvePlacement(p.x, p.y) : null;
  if (p.termIds.length === 0) {
    materializeTree({ at: performance.now(), payload: p, attached: new Map(), placement });
    return;
  }
  const batch: PendingMoveBatch = {
    at: performance.now(),
    payload: p,
    attached: new Map(),
    placement,
  };
  for (const id of p.termIds) pendingMoveBatches.set(id, batch);
}

/** Intercept a `window:tab_attached` event for a leaf that's part of a
 *  pending move batch — called from App.vue's onTabAttached *before* its
 *  normal one-tab-per-attach hydration. Returns true once absorbed (the
 *  caller must skip normal hydration for it); assembles the whole tree
 *  into one new tab once every leaf named in the batch has arrived. */
export function tryAbsorbIntoMoveBatch(info: TabHydrateInfo): boolean {
  const batch = pendingMoveBatches.get(info.id);
  if (!batch) return false;
  if (performance.now() - batch.at > MOVE_BATCH_TTL_MS) {
    for (const id of batch.payload.termIds) pendingMoveBatches.delete(id);
    return false;
  }
  batch.attached.set(info.id, info);
  if (batch.attached.size === batch.payload.termIds.length) {
    for (const id of batch.payload.termIds) pendingMoveBatches.delete(id);
    materializeTree(batch);
  }
  return true;
}

function materializeTree(batch: PendingMoveBatch): void {
  const p = batch.payload;
  const focusRef = { id: -1 };
  const root = buildWorkspaceFromWire(p.tree, batch.attached, focusRef);
  const soleTermInfo =
    p.termIds.length === 1 ? batch.attached.get(p.termIds[0]) : undefined;
  const meta = p.whole
    ? { hostLabel: p.whole.hostLabel, hostId: p.whole.hostId, disableSftp: p.whole.disableSftp }
    : soleTermInfo
      ? metaFromHydrateInfo(soleTermInfo)
      : undefined;
  const title = p.whole?.title ?? (root.kind === "leaf" ? root.origin.title : "Terminal");
  const slotId = addRestoredWorkspace(title, root, focusRef.id, meta);
  applyTabPlacement(slotId, batch.placement);
  // The panes were sized for the source window; re-tile/resize them (and
  // their backend PTYs) to this one's geometry, same as a plain attach.
  reflowActive(useTabs().active.value);
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
    listen<CrossTreeDropPayload>(
      "xdrag:drop_tree",
      (e) => onForeignTreeDrop(e.payload),
      { target: MY_TARGET },
    ),
  ]);
}
