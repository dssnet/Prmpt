<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { X } from "lucide-vue-next";

import { scrollTab, type Config } from "../ipc";
import {
  applyRendererTheme,
  commitDividerDrag,
  getActiveDividers,
  getCellMetrics,
  initTerminalSession,
  inputTargetTabId,
  layoutVersion,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  clearWorkspaceDragPreview,
  commitWorkspaceDrop,
  getActivePanes,
  pingAllForRedraw,
  pointOverTerminal,
  reflowActive,
  requestDraw,
  resolveDropAt,
  teardownTerminalSession,
  updateWorkspaceDragPreview,
  useTerminalSelection,
  wsDragPreview,
  type PaneOverlay,
} from "../state/terminal";
import {
  closeWorkspacePane,
  detachWorkspaceLeaf,
  focusWorkspacePane,
  moveWorkspaceLeaf,
  useTabs,
} from "../state/tabs";
import { workspaceTick, type DividerRect } from "../state/workspace";
import { useTheme } from "../state/theme";

const props = defineProps<{ config: Config }>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const hostRef = ref<HTMLElement | null>(null);

const { active, tabs, renderSeq } = useTabs();
const { selectionTick } = useTerminalSelection();
const { theme } = useTheme();

const canvasVisible = computed(() => active.value?.kind !== "home");

// Drop highlight (shared with the tab drag handlers in TabBar) + divider
// overlays. Layout is read from the cache in state/terminal.
const dropHi = wsDragPreview;
const dividers = ref<DividerRect[]>([]);
const panes = ref<PaneOverlay[]>([]);

function refreshOverlays(): void {
  dividers.value = getActiveDividers();
  panes.value = getActivePanes();
}
const refreshDividers = refreshOverlays;

const TAB_MIME = "application/x-prmpt-tab";

let wheelAccum = 0;

const onWindowMouseMove = (e: MouseEvent) => onMouseMove(e);
const onWindowMouseUp = () => onMouseUp();

let resizeObs: ResizeObserver | null = null;

function onHostMouseDown(e: MouseEvent) {
  onMouseDown(e, active.value?.kind);
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
  const target = inputTargetTabId();
  if (target == null) return;
  void scrollTab(target, { kind: "delta", delta: rows });
}

function onHostContextMenu(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
}

// ---- Tab → terminal-area drop (create / extend a workspace) ---------------

function dragHasTab(e: DragEvent): boolean {
  const t = e.dataTransfer?.types;
  if (!t) return false;
  if (Array.prototype.includes.call(t, TAB_MIME)) return true;
  // WebKit often hides custom MIME types during dragover (exposing them only
  // on drop) and reports an empty type list for in-page drags. Treat that as
  // a potential tab drag — OS file drags instead report "Files" here, so they
  // still won't trigger the workspace preview.
  return t.length === 0;
}

// Document-level so the live preview tracks the cursor across the whole
// window during a native drag (WKWebView only delivers dragover to the
// element actually under the pointer, and the canvas/overlays sit on top of
// the host). preventDefault is required for the drop to be accepted and for
// dragover to keep firing.
function onDocDragOver(e: DragEvent) {
  if (!dragHasTab(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  updateWorkspaceDragPreview(e.clientX, e.clientY);
}

function onDocDrop(e: DragEvent) {
  if (!dragHasTab(e)) return;
  e.preventDefault();
  const raw = e.dataTransfer?.getData(TAB_MIME);
  const draggedId = raw ? Number(raw) : NaN;
  if (Number.isFinite(draggedId)) {
    commitWorkspaceDrop(draggedId, e.clientX, e.clientY);
  }
  clearWorkspaceDragPreview();
}

function onDocDragEnd() {
  // Drag cancelled or ended outside the terminal — drop the stale highlight.
  clearWorkspaceDragPreview();
}

// ---- Divider drag (resize splits) -----------------------------------------

let dragSplitId: string | null = null;
let pendingDividerEvent: MouseEvent | null = null;
let dividerRaf = 0;

function onDividerDown(d: DividerRect, e: MouseEvent) {
  e.preventDefault();
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

const paneGhost = ref<{ x: number; y: number; label: string } | null>(null);
let paneDrag: {
  tabId: number;
  slotId: number;
  label: string;
  startX: number;
  startY: number;
  active: boolean;
} | null = null;

function workspaceSlotId(): number | null {
  return active.value?.kind === "workspace" ? active.value.id : null;
}

function onPaneBarDown(p: PaneOverlay, e: MouseEvent) {
  if (e.button !== 0) return;
  const slotId = workspaceSlotId();
  if (slotId == null) return;
  e.preventDefault();
  e.stopPropagation(); // don't begin a terminal text selection
  focusWorkspacePane(slotId, p.tabId);
  paneDrag = {
    tabId: p.tabId,
    slotId,
    label: p.title,
    startX: e.clientX,
    startY: e.clientY,
    active: false,
  };
  window.addEventListener("mousemove", onPaneDragMove);
  window.addEventListener("mouseup", onPaneDragUp);
}

function onPaneDragMove(e: MouseEvent) {
  if (!paneDrag) return;
  if (!paneDrag.active) {
    const dx = e.clientX - paneDrag.startX;
    const dy = e.clientY - paneDrag.startY;
    if (dx * dx + dy * dy < 25) return; // 5px before it's a real drag
    paneDrag.active = true;
  }
  paneGhost.value = { x: e.clientX, y: e.clientY, label: paneDrag.label };
  updateWorkspaceDragPreview(e.clientX, e.clientY);
}

function onPaneDragUp(e: MouseEvent) {
  window.removeEventListener("mousemove", onPaneDragMove);
  window.removeEventListener("mouseup", onPaneDragUp);
  const d = paneDrag;
  paneDrag = null;
  paneGhost.value = null;
  clearWorkspaceDragPreview();
  if (!d || !d.active) return;
  if (pointOverTerminal(e.clientX, e.clientY)) {
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
  // Released off the terminal (e.g. onto the tab bar) → pop the pane back out
  // into its own standalone tab.
  detachWorkspaceLeaf(d.slotId, d.tabId);
}

function onPaneClose(p: PaneOverlay) {
  void closeWorkspacePane(p.tabId);
}

onMounted(() => {
  if (!canvasRef.value || !hostRef.value) return;
  initTerminalSession({
    canvas: canvasRef.value,
    host: hostRef.value,
    config: props.config,
  });
  resizeObs = new ResizeObserver(() => reflowActive(active.value));
  resizeObs.observe(hostRef.value);
  window.addEventListener("mousemove", onWindowMouseMove);
  window.addEventListener("mouseup", onWindowMouseUp);
  document.addEventListener("dragover", onDocDragOver);
  document.addEventListener("drop", onDocDrop);
  document.addEventListener("dragend", onDocDragEnd);
});

onBeforeUnmount(() => {
  resizeObs?.disconnect();
  resizeObs = null;
  window.removeEventListener("mousemove", onWindowMouseMove);
  window.removeEventListener("mouseup", onWindowMouseUp);
  document.removeEventListener("dragover", onDocDragOver);
  document.removeEventListener("drop", onDocDrop);
  document.removeEventListener("dragend", onDocDragEnd);
  window.removeEventListener("mousemove", onPaneDragMove);
  window.removeEventListener("mouseup", onPaneDragUp);
  onDividerUp();
  teardownTerminalSession();
});

watch(active, () => {
  if (active.value?.kind === "home") return;
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
  pingAllForRedraw(tabs.value);
  requestDraw();
});
</script>

<template>
  <div
    id="terminal-host"
    ref="hostRef"
    class="flex-1 relative overflow-hidden block select-none m-1"
    @mousedown="onHostMouseDown"
    @wheel="onHostWheel"
    @contextmenu="onHostContextMenu"
  >
    <canvas
      id="terminal-canvas"
      ref="canvasRef"
      tabindex="0"
      class="absolute inset-0 w-full h-full block"
      :style="{ visibility: canvasVisible ? 'visible' : 'hidden' }"
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
    <!-- Per-pane hover bar: appears at the top of each pane; drag to move,
         button to close. -->
    <div
      v-for="p in panes"
      :key="p.tabId"
      class="pane-overlay"
      :style="{
        left: `${p.x}px`,
        top: `${p.y}px`,
        width: `${p.w}px`,
        height: `${p.h}px`,
      }"
    >
      <div
        class="pane-bar"
        :title="p.title"
        @mousedown="onPaneBarDown(p, $event)"
      >
        <span class="pane-title">{{ p.title }}</span>
        <button
          type="button"
          class="pane-close"
          title="Close pane"
          @mousedown.stop.prevent
          @click.stop="onPaneClose(p)"
        >
          <X :size="12" :stroke-width="2.25" />
        </button>
      </div>
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
    <slot />
  </div>
  <Teleport to="body">
    <div
      v-if="paneGhost"
      class="pane-drag-ghost"
      :style="{ left: `${paneGhost.x + 12}px`, top: `${paneGhost.y + 12}px` }"
    >
      {{ paneGhost.label }}
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
}
.pane-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 22px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px 0 8px;
  box-sizing: border-box;
  pointer-events: auto;
  cursor: grab;
  user-select: none;
  font-size: 11px;
  color: var(--fg-muted, #cdd6f4);
  background: color-mix(in srgb, var(--surface-3, #313244) 80%, transparent);
  border-bottom: 1px solid
    color-mix(in srgb, var(--border-strong, rgba(255, 255, 255, 0.18)) 60%, transparent);
  border-radius: 4px 4px 0 0;
  opacity: 0;
  transition: opacity 120ms ease;
}
.pane-bar:hover,
.pane-bar:active {
  opacity: 1;
}
.pane-bar:active {
  cursor: grabbing;
}
.pane-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
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
.pane-drag-ghost {
  position: fixed;
  z-index: 9999;
  pointer-events: none;
  max-width: 220px;
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
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent, #89b4fa) 30%, transparent) inset;
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
