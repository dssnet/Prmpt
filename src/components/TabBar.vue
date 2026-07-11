<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  Asterisk,
  Bell,
  ChevronDown,
  Columns2,
  GitBranch,
  Globe,
  LayoutGrid,
  PanelRight,
  Save,
  Trash2,
  X,
} from "lucide-vue-next";

import {
  HOME_TAB_ID,
  moveTab,
  openPanelTab,
  setActive,
  useTabs,
  type TabState,
} from "../state/tabs";
import type { PanelKind } from "../state/panels";
import { requestCloseTab } from "../state/closeGuard";
import { bellTabs } from "../state/notifications";
import { popupMenu } from "../contextMenu";
import { loadSavedWorkspace } from "../state/connect";
import {
  deleteSavedWorkspace,
  listSavedWorkspaces,
  saveWorkspaceLayout,
  type SavedWorkspaceRow,
} from "../state/savedWorkspaces";
import { Button, ConfirmDialog, Input, Modal } from "./ui";
import {
  collectLeaves,
  getWorkspace,
  workspaceTick,
} from "../state/workspace";
import NotificationCenter from "./NotificationCenter.vue";
import UpdateIcon from "./UpdateIcon.vue";
import {
  commitPanelWorkspaceDrop,
  commitWorkspaceDrop,
  pointOverTerminal,
} from "../state/terminal";
import {
  barInsertPoint,
  beginCrossDrag,
  clearDragAffordances,
  DRAG_START_PX,
  dragAffordances,
  dropNewPanelOut,
  dropTabOut,
  endCrossDrag,
  moveCrossDrag,
  registerBarDropResolver,
  shouldLeaveWindow,
  unregisterBarDropResolver,
} from "../state/drag";

const emit = defineEmits<{
  requestNewTab: [];
  newTabWorkspace: [clientX: number, clientY: number];
  newTabWindow: [screenX: number, screenY: number];
}>();

const { tabs, active } = useTabs();

const homeTab = computed(() => tabs.value.find((t) => t.kind === "home"));
const otherTabs = computed(() => tabs.value.filter((t) => t.kind !== "home"));

const tabBase =
  "flex items-center h-6 gap-1.5 text-xs cursor-pointer rounded-full";
const tabPill = `${tabBase} pl-3.5 pr-1 min-w-[110px] max-w-[200px]`;
const tabHome = `${tabBase} flex-none w-10 min-w-0 p-0 justify-center`;

function classFor(t: TabState): string {
  const isActive = active.value?.id === t.id;
  const tone = isActive
    ? "bg-surface-3 text-fg"
    : "bg-surface-1 text-fg-subtle hover:bg-surface-2 hover:text-fg-muted";
  const layout = t.kind === "home" ? tabHome : tabPill;
  return `${layout} ${tone}`;
}

function labelFor(t: TabState): string {
  if (t.title && t.title.length > 0) return t.title;
  if (t.hostId != null) return t.hostLabel ?? "SSH";
  return "Terminal";
}

/** An SSH-connection tab (shell or SFTP-only) shows a globe. */
function tabIsSsh(t: TabState): boolean {
  return t.hostId != null;
}

/** Pane count for the active workspace (touches workspaceTick for reactivity),
 *  so a multi-pane tab can show the split icon. */
function tabPaneCount(t: TabState): number {
  void workspaceTick.value;
  if (t.kind !== "workspace") return 0;
  const ws = getWorkspace(t.id);
  return ws ? collectLeaves(ws.root).length : 1;
}

function onTabClick(t: TabState): void {
  if (performance.now() < suppressClickUntil) return;
  setActive(t.id);
}

function onCloseClick(t: TabState, e: MouseEvent): void {
  e.stopPropagation();
  if (t.id === HOME_TAB_ID) return;
  void requestCloseTab(t);
}

// Middle-click anywhere on a tab closes it (matches browser convention).
function onMiddleClose(t: TabState): void {
  if (t.id === HOME_TAB_ID) return;
  void requestCloseTab(t);
}

// Tabs use a custom mouse-driven drag rather than HTML5 DnD: WKWebView does
// not reliably deliver dragover/drag coordinates for in-page drags, so the
// live workspace preview needs real mousemove positions. Tear-off still works
// because mouse events keep flowing to this window while the button is held,
// even over other windows (implicit capture). The shared affordances (ghost,
// split highlight, cross-window hover) live in state/drag; only the in-strip
// carry/reorder physics below are tab-bar specific.

interface DragState {
  tabId: number;
  label: string;
  startScreenX: number;
  startScreenY: number;
  active: boolean;
  // Multi-pane workspace tabs can be reordered and merged into another
  // workspace, but not torn off (tear-off moves one backend tab id across
  // windows; it can't carry a tree yet).
  noTearOff: boolean;
  // The tab's own DOM node (stable across reorder — keyed by id), the grab
  // point within it, and its width, so it can ride under the cursor.
  el: HTMLElement;
  grabOffsetX: number;
  width: number;
}
let drag: DragState | null = null;
let suppressClickUntil = 0;
let pointerX = 0;
// Last horizontal drag direction — picks which edge of the carried tab is the
// "leading" one for the half-over reorder threshold.
let dragDirRight = true;
let rafId = 0;
let pinning = false;
let pinnedEl: HTMLElement | null = null;

// Live ordered list of currently-rendered visible tab elements, skipping any
// mid leave-transition so a closing tab doesn't poison hit testing. DOM order
// matches visibleTabs order.
function visibleTabEls(): { id: number; el: HTMLElement }[] {
  const root = stripEl.value?.$el ?? null;
  if (!root) return [];
  const out: { id: number; el: HTMLElement }[] = [];
  for (const el of Array.from(
    root.querySelectorAll<HTMLElement>("[data-tab-id]"),
  )) {
    if (el.classList.contains("tab-leave-active")) continue;
    const id = Number(el.dataset.tabId);
    if (Number.isFinite(id)) out.push({ id, el });
  }
  return out;
}

// Cursor within the tab bar (+ a little vertical slop) = the reorder zone.
// Checked first on mouseup so a long horizontal drag can't tear off.
const TAB_BAR_Y_SLOP = 8;
function pointInTabBar(cx: number, cy: number): boolean {
  const root = outerEl.value;
  if (!root) return false;
  const r = root.getBoundingClientRect();
  return (
    cx >= r.left &&
    cx <= r.right &&
    cy >= r.top - TAB_BAR_Y_SLOP &&
    cy <= r.bottom + TAB_BAR_Y_SLOP
  );
}

// Once-per-slot guard: only call moveTab when the target slot actually
// changes, so the .tab-move animation doesn't thrash on every mousemove.
let lastReorderBeforeId: number | null | undefined = undefined;

// The carried tab's left edge, clamped to the strip. The strip no longer
// clips (the enter/move overshoot needs to paint past the edges), so the
// clamp is what keeps a dragged tab from sliding over the home button /
// overflow dropdown on the left or the + button on the right — it stops
// flush at the first/last slot while the cursor keeps going.
function clampedDragLeft(): number {
  if (!drag) return pointerX;
  const left = pointerX - drag.grabOffsetX;
  const root = stripEl.value?.$el ?? null;
  if (!root) return left;
  const r = root.getBoundingClientRect();
  const max = Math.max(r.left, r.right - drag.width);
  return Math.min(Math.max(left, r.left), max);
}

// Pushing past a strip end doesn't stop dead: the tab rubber-bands a few px
// past the clamp (asymptotic, capped at EDGE_MAX_OVER) and an underdamped
// spring animates that overshoot, so slamming into the edge bounces a touch
// and letting the cursor back in springs the tab back flush. Purely visual —
// reorder logic keeps using the hard-clamped position.
const EDGE_MAX_OVER = 14; // px the tab can be pushed past the strip end
const EDGE_GIVE = 0.5; // follow ratio just past the edge (1 = sticks to cursor)
const EDGE_STIFFNESS = 2400; // spring k (1/s²) — stiff enough to feel instant
const EDGE_DAMPING = 44; // ζ ≈ 0.45 → a small visible bounce
let edgeOver = 0;
let edgeVel = 0;
let lastFrameTs = 0;

// Glue the picked-up tab under the cursor every frame. It keeps its own DOM
// node (keyed by id) as the array reorders, so we just translate it from
// wherever the layout put it to where the cursor is holding it.
function dragFrame(ts: number): void {
  if (!drag || !drag.active || !pinnedEl) return;
  const el = pinnedEl;
  if (el.isConnected) {
    const target = clampedDragLeft();
    const excess = pointerX - drag.grabOffsetX - target; // signed px past the end
    // tanh: near-linear give at first (EDGE_GIVE of cursor speed), then walls
    // hard at EDGE_MAX_OVER — soft contact, stiff limit.
    const want =
      Math.tanh((excess * EDGE_GIVE) / EDGE_MAX_OVER) * EDGE_MAX_OVER;
    const dt = lastFrameTs ? Math.min((ts - lastFrameTs) / 1000, 1 / 30) : 1 / 60;
    edgeVel += (EDGE_STIFFNESS * (want - edgeOver) - EDGE_DAMPING * edgeVel) * dt;
    edgeOver += edgeVel * dt;
    el.style.transform = "";
    const left = el.getBoundingClientRect().left;
    el.style.transform = `translateX(${Math.round(target + edgeOver - left)}px)`;
  }
  lastFrameTs = ts;
  rafId = requestAnimationFrame(dragFrame);
}

function startPin(): void {
  if (pinning || !drag) return;
  pinning = true;
  pinnedEl = drag.el;
  pinnedEl.classList.remove("tab-settle");
  pinnedEl.classList.add("tab-dragging");
  edgeOver = 0;
  edgeVel = 0;
  lastFrameTs = 0;
  rafId = requestAnimationFrame(dragFrame);
}

// settle=true → let it glide from the cursor to its final slot on drop.
function stopPin(settle: boolean): void {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  if (!pinning) return;
  pinning = false;
  const el = pinnedEl;
  pinnedEl = null;
  if (!el) return;
  el.classList.remove("tab-dragging");
  const hasTransform = !!el.style.transform && el.style.transform !== "none";
  if (settle && hasTransform) {
    el.classList.add("tab-settle");
    requestAnimationFrame(() => {
      el.style.transform = "";
    });
    window.setTimeout(() => el.classList.remove("tab-settle"), 240);
  } else {
    el.style.transform = "";
  }
}

// A neighbor yields its slot as soon as the dragged tab covers more than half
// of it: compare the dragged tab's *leading* edge (right edge when moving
// right, left when moving left) against the other tabs' centers. Uses the
// clamped visual position so the trigger matches what the user sees — and at
// the strip ends the end tab's center stays strictly past the clamped edge,
// so the outermost slots remain reachable. Only the leading edge is checked;
// after a swap the neighbor's layout slot moves away, which gives natural
// hysteresis instead of flip-flopping at the threshold.
function computeReorderBeforeId(): number | null {
  if (!drag) return null;
  const left = clampedDragLeft();
  const edge = dragDirRight ? left + drag.width : left;
  for (const { id, el } of visibleTabEls()) {
    if (id === drag.tabId) continue; // skip the tab being carried
    const t = tabs.value.find((x) => x.id === id);
    if (!t || t.kind === "home") continue;
    const r = el.getBoundingClientRect();
    if (edge < r.left + r.width / 2) return id;
  }
  return null; // leading edge past the last center → append
}

function applyLiveReorder(): void {
  if (!drag) return;
  const beforeId = computeReorderBeforeId();
  if (beforeId === drag.tabId) return; // dropping onto itself → no-op
  if (beforeId === lastReorderBeforeId) return; // slot unchanged
  lastReorderBeforeId = beforeId;
  // Vue's TransitionGroup decides whether to run the .tab-move FLIP at all by
  // probing the computed transition of a *clone of its first child* — and the
  // clone keeps imperatively-added classes. When the carried tab is that first
  // child (dragging the first tab, or a tab parked in slot 0), .tab-dragging's
  // `transition: none` makes the probe fail and every neighbor's slide-over is
  // skipped. Take the class off for the reorder's render flush and restore it
  // on nextTick — after the probe/FLIP ran, before anything paints.
  const el = pinning ? pinnedEl : null;
  el?.classList.remove("tab-dragging");
  moveTab(drag.tabId, beforeId);
  if (el) {
    void nextTick(() => {
      if (pinning && pinnedEl === el) el.classList.add("tab-dragging");
    });
  }
}

function onTabMouseDown(t: TabState, e: MouseEvent): void {
  if (e.button !== 0) return; // left button only
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  drag = {
    tabId: t.id,
    label: labelFor(t),
    startScreenX: e.screenX,
    startScreenY: e.screenY,
    active: false,
    // Any tab can be grafted into another workspace (multi-pane trees merge
    // whole); only single-pane tabs can tear off into another window.
    noTearOff: tabPaneCount(t) > 1,
    el,
    grabOffsetX: e.clientX - r.left,
    width: r.width,
  };
  pointerX = e.clientX;
  lastReorderBeforeId = undefined;
  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragUp);
}

function onDragMove(e: MouseEvent): void {
  if (!drag) return;
  if (e.clientX !== pointerX) dragDirRight = e.clientX > pointerX;
  pointerX = e.clientX;
  if (!drag.active) {
    const dx = e.screenX - drag.startScreenX;
    const dy = e.screenY - drag.startScreenY;
    if (dx * dx + dy * dy < DRAG_START_PX * DRAG_START_PX) return;
    drag.active = true;
    // Arm cross-window hover (fetches the other windows' rects once).
    // noTearOff tabs can't cross windows, so they never arm it.
    if (!drag.noTearOff) void beginCrossDrag(drag.label);
  }
  // Inside the bar: carry the tab under the cursor and reorder live.
  if (pointInTabBar(e.clientX, e.clientY)) {
    clearDragAffordances();
    moveCrossDrag(e.screenX, e.screenY, true);
    startPin();
    applyLiveReorder();
    return;
  }
  // Left the bar: drop the carried look — settling, so the tab glides back to
  // its slot instead of teleporting while the ghost takes over. Re-arm the
  // slot guard so re-entering the bar recomputes from scratch.
  stopPin(true);
  lastReorderBeforeId = undefined;
  // Outside the bar: ghost + drop affordances here and, over another Prmpt
  // window, forwarded there.
  dragAffordances(e, { label: drag.label, draggedId: drag.tabId });
}

function onDragUp(e: MouseEvent): void {
  window.removeEventListener("mousemove", onDragMove);
  window.removeEventListener("mouseup", onDragUp);
  const d = drag;
  const inBar = !!d && pointInTabBar(e.clientX, e.clientY);
  stopPin(inBar); // settle into the slot if dropped in the bar
  drag = null;
  clearDragAffordances();
  if (!d || !d.active) return; // never moved → it was a click
  // Swallow the click that follows this drag so it doesn't also switch tabs.
  suppressClickUntil = performance.now() + 300;

  // Released inside the bar → it was a reorder, already applied live.
  if (inBar) {
    endCrossDrag();
    return;
  }

  // Released over this window's terminal area → workspace split/merge.
  if (pointOverTerminal(e.clientX, e.clientY)) {
    endCrossDrag();
    commitWorkspaceDrop(d.tabId, e.clientX, e.clientY);
    return;
  }
  // Otherwise → leave the window: attach to the one under the cursor, or
  // tear off past the threshold. dropTabOut ends the cross-drag state.
  if (d.noTearOff) return; // multi-pane trees can't cross windows yet
  if (!shouldLeaveWindow(e, d.startScreenX, d.startScreenY)) {
    endCrossDrag();
    return;
  }
  void dropTabOut(d.tabId, e.screenX, e.screenY);
}

// The + button (and the panel options in its right-click menu) share the tabs'
// mouse-driven drag (HTML5 DnD is unreliable in WKWebView). There's no DOM node
// to carry and no slot to reorder, so it's a trimmed version: just the ghost +
// workspace preview, resolving on release to a new tab, a workspace split, or a
// new window. `kind` decides what gets created at each landing:
//   - "terminal" → App spawns the backend shell (it owns the cell metrics);
//   - "files"/"git" → a frontend panel, opened here directly.
type SpawnKind = "terminal" | PanelKind;
interface SpawnDrag {
  kind: SpawnKind;
  startScreenX: number;
  startScreenY: number;
  active: boolean;
}
let spawnDrag: SpawnDrag | null = null;

const SPAWN_LABEL: Record<SpawnKind, string> = {
  terminal: "New terminal",
  files: "File Browser",
  git: "Git",
};

function onSpawnMouseDown(kind: SpawnKind, e: MouseEvent): void {
  if (e.button !== 0) return; // left button only
  plusMenuOpen.value = false; // a menu option being dragged closes the menu
  spawnDrag = {
    kind,
    startScreenX: e.screenX,
    startScreenY: e.screenY,
    active: false,
  };
  window.addEventListener("mousemove", onSpawnMove);
  window.addEventListener("mouseup", onSpawnUp);
}

function onSpawnMove(e: MouseEvent): void {
  if (!spawnDrag) return;
  if (!spawnDrag.active) {
    const dx = e.screenX - spawnDrag.startScreenX;
    const dy = e.screenY - spawnDrag.startScreenY;
    if (dx * dx + dy * dy < DRAG_START_PX * DRAG_START_PX) return;
    spawnDrag.active = true;
    // Everything the + button spawns can land in another window (terminals
    // via the tab tear-off/attach path, panels by value), so always arm
    // cross-window hover.
    void beginCrossDrag(SPAWN_LABEL[spawnDrag.kind]);
  }
  // Inside the bar: no affordance — releasing here is just "new tab".
  if (pointInTabBar(e.clientX, e.clientY)) {
    clearDragAffordances();
    moveCrossDrag(e.screenX, e.screenY, true);
    return;
  }
  // Outside the bar: same ghost + drop affordances tabs show.
  dragAffordances(e, { label: SPAWN_LABEL[spawnDrag.kind] });
}

function onSpawnUp(e: MouseEvent): void {
  window.removeEventListener("mousemove", onSpawnMove);
  window.removeEventListener("mouseup", onSpawnUp);
  const d = spawnDrag;
  spawnDrag = null;
  clearDragAffordances();
  if (!d) return;
  const kind = d.kind;
  // Never moved (or dropped back in the bar) → a plain new tab of this kind.
  if (!d.active || pointInTabBar(e.clientX, e.clientY)) {
    endCrossDrag();
    spawnNewTabHere(kind);
    return;
  }
  // Over this window's terminal → split into the workspace there. Terminals go
  // through App (it spawns the backend shell); panels open directly.
  if (pointOverTerminal(e.clientX, e.clientY)) {
    endCrossDrag();
    if (kind === "terminal") emit("newTabWorkspace", e.clientX, e.clientY);
    else commitPanelWorkspaceDrop(kind, e.clientX, e.clientY);
    return;
  }
  // Leaving the window (over another Prmpt window, or far enough out for a
  // new one) → open there.
  if (shouldLeaveWindow(e, d.startScreenX, d.startScreenY)) {
    if (kind === "terminal") {
      // App spawns the shell, then hands it to the shared dropTabOut.
      emit("newTabWindow", e.screenX, e.screenY);
    } else {
      dropNewPanelOut(kind, e.screenX, e.screenY);
    }
    return;
  }
  // Small drag that left the bar but landed nowhere meaningful → new tab.
  endCrossDrag();
  spawnNewTabHere(kind);
}

function spawnNewTabHere(kind: SpawnKind): void {
  if (kind === "terminal") emit("requestNewTab");
  else openPanelTab({ kind });
}

// ---- Bar drops from outside the strip ---------------------------------------
// Two drags can land in the bar without having started there: a tab dragged
// over from another window (state/drag.ts forwards its cursor here) and a
// pane dragged off the active workspace (TerminalView, detaching into its
// own tab). Both feed `barInsertPoint`; this side renders the slot insertion
// indicator and the registered resolver places the actual drop.

/** The slot a bar drop at x would insert before (null = append) — same
 *  half-over rule as local reorders, minus the carried-width offset. */
function barDropBeforeId(x: number): number | null {
  for (const { id, el } of visibleTabEls()) {
    const r = el.getBoundingClientRect();
    if (x < r.left + r.width / 2) return id;
  }
  return null;
}

function barDropResolver(
  x: number,
  y: number,
): { beforeId: number | null } | null {
  if (!pointInTabBar(x, y)) return null;
  return { beforeId: barDropBeforeId(x) };
}

const BAR_INDICATOR_H = 18;
const barIndicator = computed<{ left: number; top: number } | null>(() => {
  const f = barInsertPoint.value;
  if (!f || !pointInTabBar(f.x, f.y)) return null;
  const bar = outerEl.value?.getBoundingClientRect();
  if (!bar) return null;
  const els = visibleTabEls();
  let left: number;
  if (els.length === 0) {
    // Empty strip: where the first tab would land, right after home.
    left = bar.left + OUTER_PX / 2 + HOME_W + GAP / 2;
  } else {
    const beforeId = barDropBeforeId(f.x);
    const el =
      beforeId != null ? els.find((t) => t.id === beforeId)?.el : undefined;
    left = el
      ? el.getBoundingClientRect().left - GAP / 2
      : els[els.length - 1].el.getBoundingClientRect().right + GAP / 2;
  }
  return { left, top: bar.top + (bar.height - BAR_INDICATOR_H) / 2 };
});

// Right-clicking the + opens a small inline menu of the *other* new-pane kinds
// (left-click / left-drag default to a terminal). Its rows are draggable just
// like the + itself — drop onto the terminal to split a panel in, or out for a
// panel window.
const plusMenuOpen = ref(false);
const plusWrapEl = ref<HTMLDivElement | null>(null);
const plusMenuEl = ref<HTMLDivElement | null>(null);

function onPlusContextMenu(e: MouseEvent): void {
  e.preventDefault();
  plusMenuOpen.value = !plusMenuOpen.value;
  if (plusMenuOpen.value) void refreshSaved();
}

interface PlusMenuRow {
  kind: PanelKind;
  text: string;
}
const plusMenuRows: PlusMenuRow[] = [
  { kind: "files", text: "File Browser" },
  { kind: "git", text: "Git" },
];

// ---- Saved workspaces ------------------------------------------------------
// Right-click a workspace tab → "Save Workspace…" (name dialog below).
// Right-click the + → the saved layouts list under the panel rows; click to
// reopen, trash to delete (with a confirm).
const savedWorkspaces = ref<SavedWorkspaceRow[]>([]);

async function refreshSaved(): Promise<void> {
  try {
    savedWorkspaces.value = await listSavedWorkspaces();
  } catch (err) {
    console.error("failed to list saved workspaces:", err);
  }
}

function loadWorkspace(w: SavedWorkspaceRow): void {
  plusMenuOpen.value = false;
  void loadSavedWorkspace(w.id);
}

// Delete flow: a small confirm dialog, gated on a pending row.
const pendingDelete = ref<SavedWorkspaceRow | null>(null);
function askDelete(w: SavedWorkspaceRow): void {
  plusMenuOpen.value = false; // the modal's backdrop covers the menu anyway
  pendingDelete.value = w;
}
async function confirmDelete(): Promise<void> {
  const w = pendingDelete.value;
  pendingDelete.value = null;
  if (!w) return;
  try {
    await deleteSavedWorkspace(w.id);
  } catch (err) {
    console.error("failed to delete saved workspace:", err);
  }
  await refreshSaved();
}

// Save flow: name dialog seeded with the tab's current title.
const saveDialogOpen = ref(false);
const saveSlotId = ref<number | null>(null);
const saveLabel = ref("");
const saveFormEl = ref<HTMLFormElement | null>(null);

function openSaveDialog(t: TabState): void {
  saveSlotId.value = t.id;
  saveLabel.value = labelFor(t);
  saveDialogOpen.value = true;
}
function cancelSave(): void {
  saveDialogOpen.value = false;
  saveSlotId.value = null;
}
async function submitSave(): Promise<void> {
  const label = saveLabel.value.trim();
  const slotId = saveSlotId.value;
  if (!label || slotId == null) return;
  try {
    await saveWorkspaceLayout(slotId, label);
  } catch (err) {
    console.error("failed to save workspace:", err);
  }
  saveDialogOpen.value = false;
  saveSlotId.value = null;
  await refreshSaved();
}

// Right-clicking a workspace tab offers to save its current layout or close
// the tab (same guarded path as the × button).
function onTabContextMenu(t: TabState, e: MouseEvent): void {
  e.preventDefault();
  if (t.kind !== "workspace") return;
  popupMenu([
    { text: "Save Workspace…", icon: Save, action: () => openSaveDialog(t) },
    null,
    { text: "Close", icon: X, action: () => void requestCloseTab(t) },
  ]);
}

// Overflow handling: older tabs (those opened first) collapse into a dropdown
// on the left, between home and the visible strip. The most recent tabs stay
// visible. Sizing constants match the matching Tailwind classes below; nudge
// them together if either side changes.
const outerEl = ref<HTMLDivElement | null>(null);
const stripEl = ref<{ $el: HTMLElement } | null>(null);
const outerWidth = ref(0);

const TAB_MIN_W = 110;
const GAP = 6;
const OUTER_PX = 16;
const HOME_W = 40;
const PLUS_W = 24;
const BELL_W = 24; // notification-center trigger at the far right
const DROPDOWN_W = 36; // compact trigger: chevron + count

const visibleCount = computed(() => {
  const w = outerWidth.value;
  const total = otherTabs.value.length;
  if (w <= 0 || total === 0) return total;
  const inner = w - OUTER_PX;

  // All fit without a dropdown: home + strip + plus + bell → 4 children, 3 gaps.
  const stripAllWidth = total * (TAB_MIN_W + GAP) - GAP;
  if (inner >= HOME_W + stripAllWidth + PLUS_W + BELL_W + 3 * GAP) return total;

  // With dropdown: home + dropdown + strip + plus + bell → 5 children, 4 gaps.
  const budget = inner - HOME_W - DROPDOWN_W - PLUS_W - BELL_W - 4 * GAP;
  if (budget < TAB_MIN_W) return 0;
  return Math.max(0, Math.floor((budget + GAP) / (TAB_MIN_W + GAP)));
});

// Older (first-opened) tabs land in the dropdown; newer ones stay visible.
const overflowTabs = computed(() => {
  const v = visibleCount.value;
  const all = otherTabs.value;
  return all.slice(0, Math.max(0, all.length - v));
});
const visibleTabs = computed(() => {
  const v = visibleCount.value;
  const all = otherTabs.value;
  return all.slice(all.length - v);
});

const activeInOverflow = computed(() =>
  overflowTabs.value.some((t) => t.id === active.value?.id),
);
const bellInOverflow = computed(() =>
  overflowTabs.value.some((t) => bellTabs.value.has(t.id)),
);

const menuOpen = ref(false);
const triggerEl = ref<HTMLButtonElement | null>(null);
const menuEl = ref<HTMLDivElement | null>(null);

function toggleMenu(e: MouseEvent): void {
  e.stopPropagation();
  menuOpen.value = !menuOpen.value;
}
function pickOverflow(t: TabState): void {
  setActive(t.id);
  menuOpen.value = false;
}
function closeOverflow(t: TabState, e: MouseEvent): void {
  e.stopPropagation();
  void requestCloseTab(t);
}

function onDocMouseDown(e: MouseEvent): void {
  const target = e.target as Node | null;
  if (!target) return;
  if (
    menuOpen.value &&
    !menuEl.value?.contains(target) &&
    !triggerEl.value?.contains(target)
  ) {
    menuOpen.value = false;
  }
  if (plusMenuOpen.value && !plusWrapEl.value?.contains(target)) {
    plusMenuOpen.value = false;
  }
}
function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  if (menuOpen.value) menuOpen.value = false;
  if (plusMenuOpen.value) plusMenuOpen.value = false;
}

let resizeObs: ResizeObserver | null = null;
onMounted(() => {
  if (outerEl.value) {
    resizeObs = new ResizeObserver((entries) => {
      outerWidth.value = entries[0].contentRect.width;
    });
    resizeObs.observe(outerEl.value);
    outerWidth.value = outerEl.value.clientWidth;
  }
  document.addEventListener("mousedown", onDocMouseDown);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onWindowResize);
  registerBarDropResolver(barDropResolver);
});

onBeforeUnmount(() => {
  resizeObs?.disconnect();
  document.removeEventListener("mousedown", onDocMouseDown);
  document.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("resize", onWindowResize);
  unregisterBarDropResolver(barDropResolver);
});

watch(overflowTabs, (n) => {
  if (n.length === 0) menuOpen.value = false;
});

// Focus the name field when the save dialog opens.
watch(saveDialogOpen, (open) => {
  if (!open) return;
  void nextTick(() => {
    saveFormEl.value?.querySelector("input")?.focus();
  });
});

// ---- Dropdown viewport clamping --------------------------------------------
// The inline dropdowns (overflow list, + menu) hang off a trigger near the
// right of the bar and can grow tall (many older tabs / saved workspaces).
// Anchor them with fixed positioning, clamp the left edge into the viewport,
// and cap the height (scroll the overflow) so they never spill off-screen.
const DROPDOWN_PAD = 8;
const plusMenuStyle = ref<Record<string, string>>({});
const overflowMenuStyle = ref<Record<string, string>>({});

function computeDropdownStyle(
  trigger: HTMLElement | null,
  menu: HTMLElement | null,
): Record<string, string> {
  if (!trigger || !menu) return { position: "fixed", left: "0px", top: "0px" };
  const t = trigger.getBoundingClientRect();
  const top = t.bottom + 4;
  const left = Math.max(
    DROPDOWN_PAD,
    Math.min(t.left, window.innerWidth - menu.offsetWidth - DROPDOWN_PAD),
  );
  const maxHeight = Math.max(120, window.innerHeight - top - DROPDOWN_PAD);
  return {
    position: "fixed",
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    maxHeight: `${Math.round(maxHeight)}px`,
    overflowY: "auto",
  };
}

function positionPlusMenu(): void {
  plusMenuStyle.value = computeDropdownStyle(plusWrapEl.value, plusMenuEl.value);
}
function positionOverflowMenu(): void {
  overflowMenuStyle.value = computeDropdownStyle(triggerEl.value, menuEl.value);
}

watch(plusMenuOpen, (open) => {
  if (!open) return;
  plusMenuStyle.value = { position: "fixed", left: "0px", top: "0px" };
  void nextTick(positionPlusMenu);
});
watch(menuOpen, (open) => {
  if (!open) return;
  overflowMenuStyle.value = { position: "fixed", left: "0px", top: "0px" };
  void nextTick(positionOverflowMenu);
});
// The + menu's height changes when the saved-workspace list loads in async.
watch(savedWorkspaces, () => {
  if (plusMenuOpen.value) void nextTick(positionPlusMenu);
});

// A viewport change invalidates the fixed anchors — just dismiss.
function onWindowResize(): void {
  plusMenuOpen.value = false;
  menuOpen.value = false;
}
</script>

<template>
  <div
    ref="outerEl"
    class="flex-none h-tabbar flex items-center gap-1.5 px-2 bg-transparent select-none"
  >
    <div
      v-if="homeTab"
      :class="classFor(homeTab)"
      title="Home"
      aria-label="Home"
      @click="onTabClick(homeTab)"
    >
      <Asterisk :size="13" class="block pointer-events-none" />
    </div>
    <div v-if="overflowTabs.length > 0" class="relative flex-none">
      <button
        ref="triggerEl"
        type="button"
        :title="`${overflowTabs.length} older tab${overflowTabs.length === 1 ? '' : 's'}`"
        :class="[
          'h-6 px-1.5 inline-flex items-center gap-0.5 rounded-full text-xs cursor-pointer transition-colors duration-100',
          activeInOverflow
            ? 'bg-surface-3 text-fg'
            : 'bg-surface-1 text-fg-subtle hover:bg-surface-2 hover:text-fg-muted',
        ]"
        @click="toggleMenu"
      >
        <ChevronDown
          :size="12"
          :stroke-width="2.25"
          class="overflow-chevron"
          :class="{ 'is-open': menuOpen }"
        />
        <span class="tabular-nums">{{ overflowTabs.length }}</span>
        <Bell v-if="bellInOverflow" :size="10" class="flex-none text-accent" />
      </button>
      <Transition name="pop">
        <div
          v-if="menuOpen"
          ref="menuEl"
          :style="overflowMenuStyle"
          class="pop-panel origin-top-left min-w-45 max-w-70 z-50 p-1 text-xs"
        >
          <button
            v-for="(t, ti) in overflowTabs"
            :key="t.id"
            type="button"
            :style="{ '--i': ti }"
            :class="[
              'group pop-item w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-left cursor-pointer',
              active?.id === t.id
                ? 'bg-surface-2 text-fg'
                : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
            ]"
            @click="pickOverflow(t)"
            @mousedown.middle.prevent="onMiddleClose(t)"
          >
            <Globe
              v-if="tabIsSsh(t)"
              :size="12"
              class="flex-none text-fg-subtle"
            />
            <Columns2
              v-else-if="tabPaneCount(t) > 1"
              :size="12"
              class="flex-none text-fg-subtle"
            />
            <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
              {{ labelFor(t) }}
            </span>
            <span
              v-if="bellTabs.has(t.id)"
              class="flex-none w-1.5 h-1.5 rounded-full bg-accent"
              title="A task finished on this tab"
            />
            <span
              class="flex-none w-4 h-4 inline-flex items-center justify-center rounded-full text-fg-subtle opacity-0 group-hover:opacity-100 hover:text-fg"
              @click="closeOverflow(t, $event)"
            >
              <X :size="11" :stroke-width="2.25" />
            </span>
          </button>
        </div>
      </Transition>
    </div>
    <div
      v-if="visibleTabs.length > 0"
      class="flex-initial min-w-0"
    >
      <TransitionGroup
        ref="stripEl"
        tag="div"
        name="tab"
        class="flex items-center gap-1.5"
      >
        <div
          v-for="t in visibleTabs"
          :key="t.id"
          :data-tab-id="t.id"
          :class="classFor(t)"
          @click="onTabClick(t)"
          @mousedown="onTabMouseDown(t, $event)"
          @mousedown.middle.prevent="onMiddleClose(t)"
          @contextmenu="onTabContextMenu(t, $event)"
        >
          <Globe
            v-if="tabIsSsh(t)"
            :size="13"
            class="flex-none mr-1 text-fg-muted"
          />
          <Columns2
            v-else-if="tabPaneCount(t) > 1"
            :size="13"
            class="flex-none mr-1 text-fg-muted"
          />
          <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {{ labelFor(t) }}
          </span>
          <span
            v-if="bellTabs.has(t.id)"
            class="flex-none w-1.5 h-1.5 rounded-full bg-accent dot-pop"
            title="A task finished on this tab"
          />
          <span
            class="w-4 h-4 inline-flex items-center justify-center rounded-full text-fg-subtle hover:text-fg transition-colors duration-100"
            @click="onCloseClick(t, $event)"
          >
            <X :size="12" :stroke-width="2.25" />
          </span>
        </div>
      </TransitionGroup>
    </div>
    <div ref="plusWrapEl" class="relative flex-none">
      <div
        title="New tab (⌘T) — drag onto the terminal to split, out for a new window, or right-click for a panel"
        class="flex items-center justify-center w-6 h-6 rounded-full text-fg-subtle cursor-pointer text-sm leading-none bg-surface-1 hover:bg-surface-2 hover:text-fg transition-colors duration-100"
        @mousedown="onSpawnMouseDown('terminal', $event)"
        @contextmenu="onPlusContextMenu"
      >
        +
      </div>
      <Transition name="pop">
        <div
          v-if="plusMenuOpen"
          ref="plusMenuEl"
          :style="plusMenuStyle"
          class="pop-panel origin-top-left min-w-44 max-w-70 z-50 p-1 text-xs"
        >
          <button
            v-for="(row, ri) in plusMenuRows"
            :key="row.kind"
            type="button"
            :title="`Open ${row.text} — drag onto the terminal to split, or out for a new window`"
            :style="{ '--i': ri }"
            class="pop-item w-full flex items-center gap-2 px-2 py-1 rounded-md text-left cursor-pointer text-fg-muted hover:bg-surface-2 hover:text-fg"
            @mousedown="onSpawnMouseDown(row.kind, $event)"
          >
            <component
              :is="row.kind === 'git' ? GitBranch : PanelRight"
              :size="13"
              class="flex-none text-fg-subtle"
            />
            <span class="flex-1">{{ row.text }}</span>
          </button>
          <template v-if="savedWorkspaces.length > 0">
            <div class="my-1 h-px bg-border-strong/60" />
            <button
              v-for="(w, wi) in savedWorkspaces"
              :key="w.id"
              type="button"
              :title="`Open saved workspace “${w.label}”`"
              :style="{ '--i': plusMenuRows.length + wi }"
              class="group pop-item w-full flex items-center gap-2 px-2 py-1 rounded-md text-left cursor-pointer text-fg-muted hover:bg-surface-2 hover:text-fg"
              @click="loadWorkspace(w)"
            >
              <LayoutGrid :size="13" class="flex-none text-fg-subtle" />
              <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {{ w.label }}
              </span>
              <span
                class="flex-none w-5 h-5 inline-flex items-center justify-center rounded-md text-fg-subtle opacity-0 group-hover:opacity-100 hover:bg-surface-3 hover:text-danger"
                title="Delete saved workspace"
                @click.stop="askDelete(w)"
              >
                <Trash2 :size="12" :stroke-width="2.25" />
              </span>
            </button>
          </template>
        </div>
      </Transition>
    </div>
    <div class="ml-auto flex items-center gap-1.5">
      <UpdateIcon />
      <NotificationCenter />
    </div>
  </div>
  <!-- Slot insertion indicator for any bar-droppable drag (foreign tab or
       local pane detach) hovering the strip. The ghost pill itself is the
       shared DragGhost, rendered from App.vue. -->
  <Teleport to="body">
    <div
      v-if="barIndicator"
      class="xdrag-indicator"
      :style="{
        left: `${barIndicator.left - 1}px`,
        top: `${barIndicator.top}px`,
        height: `${BAR_INDICATOR_H}px`,
      }"
    />
  </Teleport>
  <Modal v-if="saveDialogOpen">
    <form
      ref="saveFormEl"
      class="flex flex-col gap-3.5"
      @submit.prevent="submitSave"
    >
      <h2 class="m-0 text-base font-semibold text-fg">Save Workspace</h2>
      <p class="m-0 text-sm text-fg-muted leading-relaxed">
        Store this tab's panes and layout so you can reopen it from the
        <span class="text-fg">+</span> menu later.
      </p>
      <Input v-model="saveLabel" placeholder="Workspace name" />
      <div class="flex justify-end gap-2 mt-1">
        <Button variant="secondary" type="button" @click="cancelSave">
          Cancel
        </Button>
        <Button variant="primary" type="submit" :disabled="!saveLabel.trim()">
          Save
        </Button>
      </div>
    </form>
  </Modal>
  <ConfirmDialog
    :open="!!pendingDelete"
    title="Delete Workspace"
    :message="
      pendingDelete
        ? `Delete the saved workspace “${pendingDelete.label}”? This can't be undone.`
        : ''
    "
    confirm-label="Delete"
    tone="danger"
    @confirm="confirmDelete"
    @cancel="pendingDelete = null"
  />
</template>

<style scoped>
/* Insertion slot for a bar-droppable drag (foreign tab / pane detach). */
.xdrag-indicator {
  position: fixed;
  z-index: 9998;
  width: 2px;
  border-radius: 1px;
  pointer-events: none;
  background: var(--accent, #89b4fa);
  box-shadow: 0 0 6px var(--accent, #89b4fa);
}
</style>

<style scoped>
/* Overflow dropdown: chevron rotation. Panel look/motion come from the
   shared `.pop-panel` recipe + `pop` transition in styles.css. */
.overflow-chevron {
  transition: transform 200ms cubic-bezier(0.34, 1.5, 0.6, 1);
}
.overflow-chevron.is-open {
  transform: rotate(180deg);
}

/* Enter: pop in from the right with a slight overshoot. */
.tab-enter-active {
  transition:
    transform 260ms cubic-bezier(0.34, 1.55, 0.55, 1),
    opacity 200ms ease-out,
    max-width 260ms cubic-bezier(0.34, 1.55, 0.55, 1),
    min-width 260ms cubic-bezier(0.34, 1.55, 0.55, 1),
    padding 260ms cubic-bezier(0.34, 1.55, 0.55, 1);
  overflow: hidden;
}
.tab-enter-from {
  opacity: 0;
  transform: scale(0.7) translateX(18px);
  max-width: 0 !important;
  min-width: 0 !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
}

/* Leave: shrink width to 0 + fade so neighbors flow in to fill the gap. */
.tab-leave-active {
  /* Fast start, gentle settle — the tab kicks shut and the gap closes softly. */
  transition:
    transform 160ms cubic-bezier(0.16, 1, 0.3, 1),
    opacity 120ms cubic-bezier(0.16, 1, 0.3, 1),
    max-width 180ms cubic-bezier(0.16, 1, 0.3, 1),
    min-width 180ms cubic-bezier(0.16, 1, 0.3, 1),
    padding 180ms cubic-bezier(0.16, 1, 0.3, 1),
    margin 180ms cubic-bezier(0.16, 1, 0.3, 1);
  overflow: hidden;
}
.tab-leave-to {
  opacity: 0;
  transform: scale(0.7);
  max-width: 0 !important;
  min-width: 0 !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
  /* Cancel one of the flex `gap` slots so the inter-tab spacing collapses
     along with the tab itself. */
  margin-left: -6px !important;
}

/* When a sibling slot opens/closes, smoothly slide remaining tabs (including
   the + button) to their new positions. */
.tab-move {
  transition: transform 260ms cubic-bezier(0.34, 1.5, 0.6, 1);
}

/* The tab currently held under the cursor: tracks the pointer with no
   transition (so it never lags), lifted above its sliding neighbors. */
.tab-dragging {
  transition: none !important;
  position: relative;
  z-index: 30;
  cursor: grabbing;
  opacity: 0.55;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  pointer-events: none;
  will-change: transform;
}

/* On drop, glide from the cursor to the resolved slot instead of snapping,
   fading back to full opacity from the dragging translucency. */
.tab-settle {
  transition:
    transform 200ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 200ms ease-out !important;
  position: relative;
  z-index: 20;
}

@media (prefers-reduced-motion: reduce) {
  .tab-enter-active,
  .tab-leave-active,
  .tab-move,
  .tab-settle {
    transition: none;
  }
}
</style>
