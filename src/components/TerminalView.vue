<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type Component } from "vue";
import { GitBranch, PanelRight, SquareSplitHorizontal, X } from "lucide-vue-next";

import { wheelScroll, type Config } from "../ipc";
import { openTerminalContextMenu, splitPane } from "../state/terminalContextMenu";
import { sftpDragGhost } from "../state/sftp";
import { highlightedPaneId } from "../state/paneHighlight";
import { isPanelLeafId, type PanelKind } from "../state/panels";
import FilesPanel from "./FilesPanel.vue";
import GitPanel from "./GitPanel.vue";
import PaneTitlebar from "./PaneTitlebar.vue";
import TerminalScrollbar from "./TerminalScrollbar.vue";
import {
  applyRendererTheme,
  commitDividerDrag,
  focusCanvas,
  getActiveDividers,
  getCellMetrics,
  initTerminalSession,
  inputTargetTabId,
  layoutVersion,
  onHoverLeave,
  onHoverMove,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  mouseReportActive,
  pointerCell,
  getActivePanes,
  getActivePanelPanes,
  pointOverTerminal,
  reflowActive,
  requestDraw,
  resolveDropAt,
  teardownTerminalSession,
  useTerminalSelection,
  wsDragPreview,
  type PaneOverlay,
  type PanelPane,
} from "../state/terminal";
import {
  detachWorkspaceLeaf,
  firstTerminalLeafId,
  focusWorkspacePane,
  moveTab,
  moveWorkspaceLeaf,
  openPanelFromTerminal,
  setPanelLeafTitle,
  setPanelLeafSeedPath,
  useTabs,
} from "../state/tabs";
import { requestClosePane } from "../state/closeGuard";
import {
  beginCrossDrag,
  clearDragAffordances,
  DRAG_START_PX,
  dragAffordances,
  dropLeafOut,
  dropTabOut,
  endCrossDrag,
  pointInOwnWindow,
  resolveBarDrop,
  shouldLeaveWindow,
} from "../state/drag";
import {
  collectLeaves,
  getWorkspace,
  workspaceTick,
  type DividerRect,
} from "../state/workspace";
import { useTheme } from "../state/theme";

const props = defineProps<{ config: Config }>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const imeRef = ref<HTMLTextAreaElement | null>(null);
const hostRef = ref<HTMLElement | null>(null);
const wrapRef = ref<HTMLElement | null>(null);

const { active, renderSeq } = useTabs();

// ---- Panel panes -----------------------------------------------------------
// Panels (file browser, git, …) are workspace leaves; their rects come from
// the same tiling layout as the terminals and render as DOM overlays. This
// map is the slot-in point for new panel types: register the component and
// the props it gets for a given pane.
const PANEL_VIEWS: Record<
  PanelKind,
  { component: Component; props: (p: PanelPane) => Record<string, unknown> }
> = {
  files: {
    component: FilesPanel,
    props: (p) => ({
      paneId: p.tabId,
      slotId: workspaceSlotId(),
      seedHostId: p.seedHostId,
      seedPath: p.seedPath,
      seedTargetTabId: p.seedTargetTabId,
    }),
  },
  git: {
    component: GitPanel,
    props: (p) => ({ paneId: p.tabId, seedPath: p.seedPath }),
  },
};

// Pills are shortcuts: each opens a fresh, self-contained panel seeded from
// the terminal it sits on (its cwd / server). `fromTabId` is the originating
// terminal pane; without one, seed from the active tab's first terminal pane
// (slot ids name no backend, so the tab id itself can't seed a cwd).
function openPanel(kind: PanelKind, fromTabId?: number): void {
  const id =
    fromTabId ??
    (active.value && active.value.kind !== "home"
      ? firstTerminalLeafId(active.value.id) ?? undefined
      : undefined);
  if (id == null) return;
  void openPanelFromTerminal(kind, id);
}

// Pill shortcut: split the pane to the right with a fresh terminal that
// inherits this pane's working directory (same path as the context menu's
// Split → Right).
function onPaneSplitRight(p: PaneOverlay): void {
  const slotId = workspaceSlotId();
  if (slotId == null) return;
  void splitPane(slotId, p.tabId, "h", false);
}

const { selectionTick } = useTerminalSelection();
const { theme } = useTheme();

// Drop highlight (shared with the tab drag handlers in TabBar) + divider
// overlays. Layout is read from the cache in state/terminal.
const dropHi = wsDragPreview;
const dividers = ref<DividerRect[]>([]);
const panes = ref<PaneOverlay[]>([]);
const panelPanes = ref<PanelPane[]>([]);

// The canvas shows only when the active workspace has at least one terminal
// pane to draw (a files/git-only workspace and home have none).
const canvasVisible = computed(
  () => active.value?.kind === "workspace" && panes.value.length > 0,
);

// A lone pane renders full-bleed: no focus ring, panel border, or dividers
// (the canvas side of this is handled by terminal.ts' panePad/cornerRadius).
const singlePane = computed(
  () => panes.value.length + panelPanes.value.length === 1,
);

function refreshOverlays(): void {
  dividers.value = getActiveDividers();
  panes.value = getActivePanes();
  panelPanes.value = getActivePanelPanes();
}
const refreshDividers = refreshOverlays;

let wheelAccum = 0;

const onWindowMouseMove = (e: MouseEvent) => onMouseMove(e);
const onWindowMouseUp = () => onMouseUp();

let resizeObs: ResizeObserver | null = null;

function onHostMouseDown(e: MouseEvent) {
  onMouseDown(e, active.value?.kind);
}

function onHostMouseMove(e: MouseEvent) {
  if (active.value?.kind === "home") return;
  onHoverMove(e);
}

function onHostWheel(e: WheelEvent) {
  if (active.value?.kind === "home") return;
  e.preventDefault();
  const { cellHeightPx } = getCellMetrics();
  const pxPerRow = cellHeightPx;
  const dy = e.deltaMode === 1 ? e.deltaY * pxPerRow : e.deltaY;
  wheelAccum += dy;
  const rows = Math.trunc(wheelAccum / pxPerRow);
  if (rows === 0) return;
  wheelAccum -= rows * pxPerRow;
  // Route to the pane under the pointer (with its cell, for mouse reporting);
  // fall back to the focused tab if the pointer isn't over a grid cell.
  const cell = pointerCell(e);
  const target = cell?.tabId ?? inputTargetTabId();
  if (target == null) return;
  void wheelScroll(target, rows, cell?.col ?? 0, cell?.row ?? 0);
}

function onHostContextMenu(e: MouseEvent) {
  // Text fields slotted into the host (HomeView) never reach this handler —
  // App.vue's capture-phase listener already opened the input menu for them.
  // Suppress WKWebView's native menu and open ours directly. We can't rely on
  // bubbling to App.vue's window-level contextmenu listener — stopping
  // propagation here is needed to keep the event from other host handlers, so
  // drive the menu ourselves.
  e.preventDefault();
  e.stopPropagation();
  // On the home tab there's no terminal under the click — Copy/Paste would
  // target a PTY that isn't even visible. Suppress the menu entirely there
  // (home's own controls and inputs bring their own menus).
  if (active.value?.kind === "home") return;
  // When the app has mouse tracking on (and Shift isn't held), the right-click
  // already went to it via onMouseDown's report path — don't also open our
  // menu. Shift+right-click still opens it.
  if (mouseReportActive(e)) return;
  openTerminalContextMenu(e);
}

// ---- Divider drag (resize splits) -----------------------------------------

let dragSplitId: string | null = null;
let pendingDividerEvent: MouseEvent | null = null;
let dividerRaf = 0;

function onDividerDown(d: DividerRect, e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation(); // don't bubble to onHostMouseDown / begin a terminal selection
  dragSplitId = d.splitId;
  window.addEventListener("mousemove", onDividerMove);
  window.addEventListener("mouseup", onDividerUp);
}

function onDividerMove(e: MouseEvent) {
  if (dragSplitId == null) return;
  pendingDividerEvent = e;
  if (dividerRaf) return;
  dividerRaf = requestAnimationFrame(() => {
    dividerRaf = 0;
    if (dragSplitId != null && pendingDividerEvent) {
      commitDividerDrag(dragSplitId, pendingDividerEvent);
    }
  });
}

function onDividerUp() {
  dragSplitId = null;
  if (dividerRaf) {
    cancelAnimationFrame(dividerRaf);
    dividerRaf = 0;
  }
  window.removeEventListener("mousemove", onDividerMove);
  window.removeEventListener("mouseup", onDividerUp);
}

// ---- Per-pane hover bar: close / move a pane ------------------------------

let paneDrag: {
  tabId: number;
  slotId: number;
  label: string;
  startX: number;
  startY: number;
  startScreenX: number;
  startScreenY: number;
  active: boolean;
  // Whether releasing off the terminal would actually detach the pane into
  // its own tab (detachWorkspaceLeaf no-ops on a workspace's only pane) —
  // gates the tab-bar insertion indicator so it never promises a drop that
  // won't happen.
  detachable: boolean;
  // The workspace's only pane: dragging it out is the same move as dragging
  // the tab itself, so the drop routes through the shared dropTabOut (whole
  // tab moves / tears off) instead of the prune-one-leaf path.
  sole: boolean;
} | null = null;

function workspaceSlotId(): number | null {
  return active.value?.kind === "workspace" ? active.value.id : null;
}

function onPaneBarDown(p: { tabId: number; title: string }, e: MouseEvent) {
  if (e.button !== 0) return;
  const slotId = workspaceSlotId();
  if (slotId == null) return;
  e.preventDefault();
  e.stopPropagation(); // don't begin a terminal text selection
  // Panel panes own their DOM focus and never take workspace (PTY) focus.
  if (!isPanelLeafId(p.tabId)) focusWorkspacePane(slotId, p.tabId);
  const ws = getWorkspace(slotId);
  const leafCount = ws ? collectLeaves(ws.root).length : 0;
  paneDrag = {
    tabId: p.tabId,
    slotId,
    label: p.title,
    startX: e.clientX,
    startY: e.clientY,
    startScreenX: e.screenX,
    startScreenY: e.screenY,
    active: false,
    detachable: leafCount > 1,
    sole: leafCount === 1,
  };
  window.addEventListener("mousemove", onPaneDragMove);
  window.addEventListener("mouseup", onPaneDragUp);
}

function onPaneDragMove(e: MouseEvent) {
  if (!paneDrag) return;
  if (!paneDrag.active) {
    const dx = e.clientX - paneDrag.startX;
    const dy = e.clientY - paneDrag.startY;
    if (dx * dx + dy * dy < DRAG_START_PX * DRAG_START_PX) return;
    paneDrag.active = true;
    // Arm cross-window hover — every pane can move to another window
    // (terminals by backend id, panels by value).
    void beginCrossDrag(paneDrag.label);
  }
  // Ghost + split highlight (+ the bar insertion indicator when a detach
  // could land in the strip) + cross-window forwarding, all shared.
  dragAffordances(e, {
    label: paneDrag.label,
    draggedId: paneDrag.tabId,
    barInsert: paneDrag.detachable,
  });
}

function onPaneDragUp(e: MouseEvent) {
  window.removeEventListener("mousemove", onPaneDragMove);
  window.removeEventListener("mouseup", onPaneDragUp);
  const d = paneDrag;
  paneDrag = null;
  clearDragAffordances();
  if (!d || !d.active) return;
  if (pointOverTerminal(e.clientX, e.clientY)) {
    endCrossDrag();
    const res = resolveDropAt(e.clientX, e.clientY);
    if (res && res.slotId === d.slotId) {
      moveWorkspaceLeaf(
        d.slotId,
        d.tabId,
        res.targetPaneTabId,
        res.dir,
        res.placeDraggedFirst,
      );
    }
    return;
  }
  // Released outside this window → the pane moves, same engine as tab drags:
  // a sole pane is the whole tab (dropTabOut: attach/recreate with placement,
  // or a fresh window past the threshold); one pane of many moves alone
  // (dropLeafOut: attach to the window under the cursor, or tear off into a
  // fresh one — same two outcomes, no threshold, since leaving a workspace
  // pane's own bounds already takes real travel). Both route terminals by
  // backend id and panels by value.
  if (!pointInOwnWindow(e.clientX, e.clientY)) {
    if (d.sole) {
      if (shouldLeaveWindow(e, d.startScreenX, d.startScreenY)) {
        void dropTabOut(d.slotId, e.screenX, e.screenY);
        return;
      }
    } else {
      dropLeafOut(d.slotId, d.tabId, e.screenX, e.screenY);
      return;
    }
  }
  endCrossDrag();
  // Released off the terminal (e.g. onto the tab bar) → pop the pane back out
  // into its own standalone tab, honoring the bar slot the indicator showed
  // when the release was over the strip (elsewhere it appends, as before).
  const bar = d.detachable ? resolveBarDrop(e.clientX, e.clientY) : null;
  const newSlot = detachWorkspaceLeaf(d.slotId, d.tabId);
  if (newSlot != null && bar) moveTab(newSlot, bar.beforeId);
}

function onPaneClose(p: { tabId: number }) {
  // requestClosePane routes panel leaves to closePanelLeaf (no confirm) and
  // terminal leaves through the running-program guard.
  void requestClosePane(p.tabId);
}

onMounted(() => {
  if (!canvasRef.value || !imeRef.value || !hostRef.value) return;
  initTerminalSession({
    canvas: canvasRef.value,
    ime: imeRef.value,
    host: hostRef.value,
    config: props.config,
  });
  resizeObs = new ResizeObserver(() => reflowActive(active.value));
  resizeObs.observe(hostRef.value);
  window.addEventListener("mousemove", onWindowMouseMove);
  window.addEventListener("mouseup", onWindowMouseUp);
});

onBeforeUnmount(() => {
  resizeObs?.disconnect();
  resizeObs = null;
  window.removeEventListener("mousemove", onWindowMouseMove);
  window.removeEventListener("mouseup", onWindowMouseUp);
  window.removeEventListener("mousemove", onPaneDragMove);
  window.removeEventListener("mouseup", onPaneDragUp);
  onDividerUp();
  teardownTerminalSession();
});

watch(active, () => {
  // A stale link underline must never decorate the next tab's first frame.
  onHoverLeave();
  if (active.value?.kind === "home") {
    // Leaving a workspace for Home: drop the pane frames / hover bars and any
    // in-flight drag affordance so they don't linger on top of the Home view.
    refreshOverlays();
    clearDragAffordances();
    return;
  }
  reflowActive(active.value);
  requestDraw();
  refreshDividers();
});

// Structural change (split/collapse/focus): re-layout panes + redraw.
watch(workspaceTick, () => {
  reflowActive(active.value);
  requestDraw();
  refreshDividers();
});

watch(layoutVersion, refreshOverlays);
watch(renderSeq, () => {
  requestDraw();
  refreshOverlays();
});
watch(selectionTick, () => requestDraw());

watch(theme, (next) => {
  applyRendererTheme(next);
  requestDraw();
});
</script>

<template>
  <div ref="wrapRef" class="flex-1 flex min-h-0 min-w-0">
  <div
    id="terminal-host"
    ref="hostRef"
    class="flex-1 relative overflow-hidden block select-none min-w-0"
    style="margin: var(--frame-inset)"
    @mousedown="onHostMouseDown"
    @mousemove="onHostMouseMove"
    @mouseleave="onHoverLeave"
    @wheel="onHostWheel"
    @contextmenu="onHostContextMenu"
  >
    <!-- Hidden IME capture: keyboard focus lives here (see focusCanvas) so
         dead-key / IME composition engages; composed text is forwarded to
         the PTY on compositionend. Normal keys are handled by App.vue's
         window keydown (which preventDefaults them before they'd insert). -->
    <textarea
      ref="imeRef"
      data-ime-capture
      tabindex="-1"
      aria-hidden="true"
      autocapitalize="off"
      autocorrect="off"
      autocomplete="off"
      spellcheck="false"
      class="absolute pointer-events-none"
      style="left: 0; top: 0; width: 1px; height: 1px; opacity: 0; resize: none; border: 0; padding: 0; outline: none"
    />
    <canvas
      id="terminal-canvas"
      ref="canvasRef"
      tabindex="0"
      class="absolute inset-0 w-full h-full block"
      :style="{ visibility: canvasVisible ? 'visible' : 'hidden' }"
      @focus="focusCanvas"
    />
    <!-- Resize dividers (workspace only). -->
    <div
      v-for="d in dividers"
      :key="d.splitId"
      class="absolute z-10"
      :class="d.dir === 'h' ? 'cursor-col-resize' : 'cursor-row-resize'"
      :style="{
        left: `${d.x}px`,
        top: `${d.y}px`,
        width: `${d.w}px`,
        height: `${d.h}px`,
      }"
      @mousedown="onDividerDown(d, $event)"
    />
    <!-- Per-pane hover header: a grip hint at the top of each pane; hovering
         it reveals a pill with the title, browser toggle, and close button.
         The pill doubles as the drag handle. -->
    <div
      v-for="p in panes"
      :key="p.tabId"
      class="pane-overlay"
      :class="{
        'pane-overlay-bare': singlePane,
        'pane-overlay-focused': p.focused && !singlePane,
        'pane-overlay-highlight': p.tabId === highlightedPaneId,
      }"
      :style="{
        left: `${p.x}px`,
        top: `${p.y}px`,
        width: `${p.w}px`,
        height: `${p.h}px`,
      }"
    >
      <PaneTitlebar :title="p.title" draggable @bardown="onPaneBarDown(p, $event)">
        <template #actions>
          <button
            type="button"
            class="pane-close"
            title="Split right (same folder)"
            @mousedown.stop.prevent
            @click.stop="onPaneSplitRight(p)"
          >
            <SquareSplitHorizontal :size="12" :stroke-width="2.25" />
          </button>
          <button
            type="button"
            class="pane-close"
            title="Open file browser"
            @mousedown.stop.prevent
            @click.stop="openPanel('files', p.tabId)"
          >
            <PanelRight :size="12" :stroke-width="2.25" />
          </button>
          <button
            v-if="p.isLocalTerminal"
            type="button"
            class="pane-close"
            title="Open git panel"
            @mousedown.stop.prevent
            @click.stop="openPanel('git', p.tabId)"
          >
            <GitBranch :size="12" :stroke-width="2.25" />
          </button>
          <button
            type="button"
            class="pane-close"
            title="Close pane"
            @mousedown.stop.prevent
            @click.stop="onPaneClose(p)"
          >
            <X :size="12" :stroke-width="2.25" />
          </button>
        </template>
      </PaneTitlebar>
    </div>
    <!-- Panel panes (file browser, git, …): workspace leaves rendered as DOM
         overlays at their tiled rects. Same hover pill as terminal panes
         (drag to rearrange, close); the view itself comes from PANEL_VIEWS. -->
    <div
      v-for="p in panelPanes"
      :key="`panel-${p.tabId}`"
      class="panel-pane"
      :style="{ left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` }"
      @mousedown.stop
      @wheel.stop
      @contextmenu.stop
    >
      <component
        :is="PANEL_VIEWS[p.kind].component"
        class="panel-pane-body"
        v-bind="PANEL_VIEWS[p.kind].props(p)"
        @close="onPaneClose(p)"
        @update:title="setPanelLeafTitle(p.tabId, $event)"
        @update:seedPath="setPanelLeafSeedPath(p.tabId, $event)"
      />
      <PaneTitlebar :title="p.title" draggable @bardown="onPaneBarDown(p, $event)">
        <template #actions>
          <button
            type="button"
            class="pane-close"
            title="Close panel"
            @mousedown.stop.prevent
            @click.stop="onPaneClose(p)"
          >
            <X :size="12" :stroke-width="2.25" />
          </button>
        </template>
      </PaneTitlebar>
    </div>

    <!-- Drop-zone preview: shows the half the dropped tab will occupy. -->
    <div
      v-if="dropHi"
      class="ws-drop-preview"
      :style="{
        left: `${dropHi.x}px`,
        top: `${dropHi.y}px`,
        width: `${dropHi.w}px`,
        height: `${dropHi.h}px`,
      }"
    />
    <!-- Scrollbars. In a workspace each pane gets its own (positioned at its
         rect); a plain terminal/ssh tab gets a single one filling the host. -->
    <TerminalScrollbar
      v-for="p in panes"
      :key="`sb-${p.tabId}`"
      :tab-id="p.tabId"
      :rect="{ x: p.x, y: p.y, w: p.w, h: p.h }"
    />
    <slot />
  </div>
  </div>
  <Teleport to="body">
    <div
      v-if="sftpDragGhost"
      class="sftp-drag-ghost"
      :style="{ left: `${sftpDragGhost.x + 14}px`, top: `${sftpDragGhost.y + 14}px` }"
    >
      {{ sftpDragGhost.label }}
    </div>
  </Teleport>
</template>

<style scoped>
/* Per-pane overlay. The wrapper is click-through; only the top bar captures
   the pointer so the rest of the pane stays interactive. */
.pane-overlay {
  position: absolute;
  z-index: 15;
  pointer-events: none;
  box-sizing: border-box;
  border: 1px solid
    color-mix(
      in srgb,
      var(--border-strong, rgba(255, 255, 255, 0.18)) 45%,
      transparent
    );
  border-radius: var(--pane-radius);
  transition: border-color 150ms ease;
}
/* A lone terminal pane fills the tab full-bleed — no border or rounded
   corners (mirrors .panel-pane-bare for panel panes). */
.pane-overlay-bare {
  border-color: transparent;
  border-radius: 0;
}
/* The focused pane carries an accent-tinted border so it reads as "active"
   alongside the full-vs-hollow cursor distinction. */
.pane-overlay-focused {
  border-color: color-mix(in srgb, var(--accent, #89b4fa) 55%, transparent);
}
/* The pane a pending "cd here / insert path" submenu entry points at, while
   its terminal row is hovered — a stronger accent ring than focus so the
   target reads at a glance. */
.pane-overlay-highlight {
  border-color: var(--accent, #89b4fa);
  box-shadow: 0 0 0 1px var(--accent, #89b4fa) inset;
}
/* The hover pill itself (grip + pill + title) lives in PaneTitlebar.vue; only
   the slotted action/close buttons are styled here (and via :slotted there). */
.pane-close {
  flex: none;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  color: var(--fg-subtle, #9399b2);
  cursor: pointer;
}
.pane-close:hover {
  color: var(--fg, #e6e6e6);
  background: color-mix(in srgb, var(--fg, #fff) 14%, transparent);
}

/* Panel pane (file browser, git, …): a workspace leaf rendered as a DOM
   overlay at its tiled rect. Mirrors the terminal panes' border/radius. */
.panel-pane {
  position: absolute;
  z-index: 16;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  border: 1px solid
    color-mix(in srgb, var(--border-strong, rgba(255, 255, 255, 0.18)) 45%, transparent);
  border-radius: var(--pane-radius);
  overflow: hidden;
  background: var(--surface-1, #1e1e2e);
}
.panel-pane-body {
  flex: 1;
  min-height: 0;
}
.sftp-drag-ghost {
  position: fixed;
  z-index: 9999;
  pointer-events: none;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 9999px;
  color: var(--fg, #e6e6e6);
  background: var(--surface-3, #333);
  border: 1px solid var(--border-strong, rgba(255, 255, 255, 0.2));
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  opacity: 0.92;
}

/* Tiling-WM style drop preview: a translucent accent panel over the half the
   dragged tab will take. Animates between zones as the cursor moves. */
.ws-drop-preview {
  position: absolute;
  z-index: 30;
  pointer-events: none;
  box-sizing: border-box;
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent, #89b4fa) 22%, transparent);
  border: 2px solid color-mix(in srgb, var(--accent, #89b4fa) 80%, transparent);
  box-shadow: 0 0 0 1px
    color-mix(in srgb, var(--accent, #89b4fa) 30%, transparent) inset;
  transition:
    left 90ms ease,
    top 90ms ease,
    width 90ms ease,
    height 90ms ease;
}

@media (prefers-reduced-motion: reduce) {
  .ws-drop-preview {
    transition: none;
  }
}
</style>
