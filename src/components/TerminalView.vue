<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { PanelBottom, PanelRight, X } from "lucide-vue-next";

import { wheelScroll, showContextMenu, type Config } from "../ipc";
import { isSftpVisible, sftpDragGhost, toggleSftpPanel } from "../state/sftp";
import { isLocalVisible, toggleLocalBrowser } from "../state/localBrowser";
import FilesPanel from "./FilesPanel.vue";
import LocalBrowser from "./LocalBrowser.vue";
import SftpBrowser from "./SftpBrowser.vue";
import TerminalScrollbar from "./TerminalScrollbar.vue";
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
  commitSftpDockResize,
  commitLocalDockResize,
  getActivePanes,
  getActiveSftpDocks,
  getActiveLocalDocks,
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
  type SftpDock,
  type LocalDock,
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
const wrapRef = ref<HTMLElement | null>(null);

const { active, tabs, renderSeq } = useTabs();

// ---- SFTP browsers --------------------------------------------------------
// Standalone SSH tab → a right-side panel (shrinks #terminal-host, reflowed by
// the ResizeObserver). Workspace SSH panes → a browser docked on each pane
// (carved out of the pane rect in reflowWorkspaceLayout; rendered as overlays).
const sftpTarget = computed<{ id: number; hostLabel?: string } | null>(() => {
  const a = active.value;
  if (!a || a.kind !== "ssh") return null; // workspaces use docked browsers
  // SFTP-only tabs use the full-width browser below, not the side panel.
  return a.disableSftp || a.disableSsh ? null : { id: a.id, hostLabel: a.hostLabel };
});

// SFTP-only SSH tab (host has `disable_ssh`): no shell, no canvas — the file
// browser takes over the whole host area as an overlay.
const fullSftp = computed<{ id: number; hostLabel?: string } | null>(() => {
  const a = active.value;
  if (!a || a.kind !== "ssh" || !a.disableSsh) return null;
  return { id: a.id, hostLabel: a.hostLabel };
});
const showSftp = computed(
  () => sftpTarget.value != null && isSftpVisible(sftpTarget.value.id),
);

// Docked browsers (workspace SSH panes), refreshed from the cached layout.
const sftpDocks = ref<SftpDock[]>([]);

// ---- Local file browser (opt-in) ------------------------------------------
// Plain terminal tab → a right-side panel (mirrors the SFTP one). Workspace
// local panes → a browser docked on each pane. Hidden by default; Cmd/Ctrl+B.
const localTarget = computed<number | null>(() => {
  const a = active.value;
  return a && a.kind === "terminal" ? a.id : null;
});
const showLocal = computed(
  () => localTarget.value != null && isLocalVisible(localTarget.value),
);
const localDocks = ref<LocalDock[]>([]);

// Toggle a pane's dock on/off, then re-tile so the terminal reclaims/yields
// the strip.
function togglePaneDock(tabId: number): void {
  toggleSftpPanel(tabId);
  reflowActive(active.value);
}
function togglePaneLocalDock(tabId: number): void {
  toggleLocalBrowser(tabId);
  reflowActive(active.value);
}

// Dock resize handle (between a pane's terminal and its browser). Shared by
// SFTP and local docks — `commit` routes the pointer Y to the right ratio.
let dockResizeRaf = 0;
let dockResizePending: { commit: (y: number) => void; y: number } | null = null;
function onDockResizeMove(e: MouseEvent) {
  if (!dockResizePending) return;
  dockResizePending.y = e.clientY;
  if (dockResizeRaf) return;
  dockResizeRaf = requestAnimationFrame(() => {
    dockResizeRaf = 0;
    if (dockResizePending) dockResizePending.commit(dockResizePending.y);
  });
}
function onDockResizeUp() {
  window.removeEventListener("mousemove", onDockResizeMove);
  window.removeEventListener("mouseup", onDockResizeUp);
  if (dockResizeRaf) {
    cancelAnimationFrame(dockResizeRaf);
    dockResizeRaf = 0;
  }
  dockResizePending = null;
  document.body.style.userSelect = "";
}
function startDockResize(commit: (y: number) => void, e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  dockResizePending = { commit, y: e.clientY };
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", onDockResizeMove);
  window.addEventListener("mouseup", onDockResizeUp);
}
function onDockResizeDown(dock: SftpDock, e: MouseEvent) {
  startDockResize((y) => commitSftpDockResize(dock, y), e);
}
function onLocalDockResizeDown(dock: LocalDock, e: MouseEvent) {
  startDockResize((y) => commitLocalDockResize(dock, y), e);
}

const SFTP_W_KEY = "prmpt.sftpPanelWidthPx";
const sftpWidth = ref<number>(360);
{
  const saved = parseInt(localStorage.getItem(SFTP_W_KEY) ?? "", 10);
  if (Number.isFinite(saved)) sftpWidth.value = saved;
}

function clampSftpWidth(px: number): number {
  const wrap = wrapRef.value?.getBoundingClientRect().width ?? window.innerWidth;
  // Keep at least ~360px for the terminal; never narrower than 260px.
  const max = Math.max(280, wrap - 360);
  return Math.min(max, Math.max(260, px));
}

let sftpDragRaf = 0;
let sftpPendingX: number | null = null;

function onSftpDividerMove(e: MouseEvent) {
  sftpPendingX = e.clientX;
  if (sftpDragRaf) return;
  sftpDragRaf = requestAnimationFrame(() => {
    sftpDragRaf = 0;
    const wrap = wrapRef.value?.getBoundingClientRect();
    if (sftpPendingX == null || !wrap) return;
    sftpWidth.value = clampSftpWidth(wrap.right - sftpPendingX);
  });
}

function onSftpDividerUp() {
  window.removeEventListener("mousemove", onSftpDividerMove);
  window.removeEventListener("mouseup", onSftpDividerUp);
  if (sftpDragRaf) {
    cancelAnimationFrame(sftpDragRaf);
    sftpDragRaf = 0;
  }
  sftpPendingX = null;
  document.body.style.userSelect = "";
  localStorage.setItem(SFTP_W_KEY, String(Math.round(sftpWidth.value)));
}

function onSftpDividerDown(e: MouseEvent) {
  e.preventDefault();
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", onSftpDividerMove);
  window.addEventListener("mouseup", onSftpDividerUp);
}

// The panel opened a second column — widen it so both fit (respecting clamp).
function onSftpExpand() {
  sftpWidth.value = clampSftpWidth(Math.max(sftpWidth.value, 680));
  localStorage.setItem(SFTP_W_KEY, String(Math.round(sftpWidth.value)));
}

// ---- Local panel width + divider (mirrors the SFTP one) -------------------
const LOCAL_W_KEY = "prmpt.localPanelWidthPx";
const localWidth = ref<number>(360);
{
  const saved = parseInt(localStorage.getItem(LOCAL_W_KEY) ?? "", 10);
  if (Number.isFinite(saved)) localWidth.value = saved;
}
let localDragRaf = 0;
let localPendingX: number | null = null;
function onLocalDividerMove(e: MouseEvent) {
  localPendingX = e.clientX;
  if (localDragRaf) return;
  localDragRaf = requestAnimationFrame(() => {
    localDragRaf = 0;
    const wrap = wrapRef.value?.getBoundingClientRect();
    if (localPendingX == null || !wrap) return;
    localWidth.value = clampSftpWidth(wrap.right - localPendingX);
  });
}
function onLocalDividerUp() {
  window.removeEventListener("mousemove", onLocalDividerMove);
  window.removeEventListener("mouseup", onLocalDividerUp);
  if (localDragRaf) {
    cancelAnimationFrame(localDragRaf);
    localDragRaf = 0;
  }
  localPendingX = null;
  document.body.style.userSelect = "";
  localStorage.setItem(LOCAL_W_KEY, String(Math.round(localWidth.value)));
}
function onLocalDividerDown(e: MouseEvent) {
  e.preventDefault();
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", onLocalDividerMove);
  window.addEventListener("mouseup", onLocalDividerUp);
}
function onLocalExpand() {
  localWidth.value = clampSftpWidth(Math.max(localWidth.value, 680));
  localStorage.setItem(LOCAL_W_KEY, String(Math.round(localWidth.value)));
}
const { selectionTick } = useTerminalSelection();
const { theme } = useTheme();

const canvasVisible = computed(
  () => active.value?.kind !== "home" && !fullSftp.value,
);

// Drop highlight (shared with the tab drag handlers in TabBar) + divider
// overlays. Layout is read from the cache in state/terminal.
const dropHi = wsDragPreview;
const dividers = ref<DividerRect[]>([]);
const panes = ref<PaneOverlay[]>([]);

function refreshOverlays(): void {
  dividers.value = getActiveDividers();
  panes.value = getActivePanes();
  sftpDocks.value = getActiveSftpDocks();
  localDocks.value = getActiveLocalDocks();
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
  void wheelScroll(target, rows);
}

function onHostContextMenu(e: MouseEvent) {
  // Suppress WKWebView's native menu and open ours directly. We can't rely on
  // bubbling to App.vue's window-level contextmenu listener — stopping
  // propagation here is needed to keep the event from other host handlers, so
  // drive the menu ourselves.
  e.preventDefault();
  e.stopPropagation();
  void showContextMenu().catch((err) =>
    console.error("show_context_menu failed:", err),
  );
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
  updateWorkspaceDragPreview(e.clientX, e.clientY, paneDrag.tabId);
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
  onSftpDividerUp();
  onDockResizeUp();
  teardownTerminalSession();
});

watch(active, () => {
  if (active.value?.kind === "home") {
    // Leaving a workspace for Home: drop the pane frames / hover bars and any
    // in-flight drag affordance so they don't linger on top of the Home view.
    refreshOverlays();
    paneGhost.value = null;
    clearWorkspaceDragPreview();
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
  pingAllForRedraw(tabs.value);
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
    <!-- Per-pane hover header: a grip hint at the top of each pane; hovering
         it reveals a pill with the title, browser toggle, and close button.
         The pill doubles as the drag handle. -->
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
      <div class="pane-hover">
        <div class="pane-grip">⋯</div>
        <div
          class="pane-pill pane-pill-drag"
          :title="p.title"
          @mousedown="onPaneBarDown(p, $event)"
        >
          <span class="pane-title">{{ p.title }}</span>
          <button
            v-if="p.sftpDockable"
            type="button"
            class="pane-close"
            :class="{ 'pane-tool-on': p.sftpVisible }"
            :title="p.sftpVisible ? 'Hide file browser' : 'Show file browser'"
            @mousedown.stop.prevent
            @click.stop="togglePaneDock(p.tabId)"
          >
            <PanelBottom :size="12" :stroke-width="2.25" />
          </button>
          <button
            v-if="p.localDockable"
            type="button"
            class="pane-close"
            :class="{ 'pane-tool-on': p.localVisible }"
            :title="p.localVisible ? 'Hide file browser' : 'Show file browser'"
            @mousedown.stop.prevent
            @click.stop="togglePaneLocalDock(p.tabId)"
          >
            <PanelBottom :size="12" :stroke-width="2.25" />
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
        </div>
      </div>
    </div>
    <!-- Docked SFTP browsers: one per SSH workspace pane, carved out of the
         bottom of the pane (the terminal already reflowed to the top strip). -->
    <div
      v-for="d in sftpDocks"
      :key="`dock-${d.tabId}`"
      class="sftp-dock"
      :style="{ left: `${d.x}px`, top: `${d.y}px`, width: `${d.w}px`, height: `${d.h}px` }"
      @mousedown.stop
      @wheel.stop
      @contextmenu.stop
    >
      <div
        class="sftp-dock-resize"
        title="Resize"
        @mousedown="onDockResizeDown(d, $event)"
      />
      <SftpBrowser
        class="sftp-dock-browser"
        :tab-id="d.tabId"
        :fixed-label="d.hostLabel"
        can-close
        @close="togglePaneDock(d.tabId)"
      />
    </div>
    <!-- Docked local browsers: one per local workspace pane (same carve as the
         SFTP docks, for terminal panes). -->
    <div
      v-for="d in localDocks"
      :key="`localdock-${d.tabId}`"
      class="sftp-dock"
      :style="{ left: `${d.x}px`, top: `${d.y}px`, width: `${d.w}px`, height: `${d.h}px` }"
      @mousedown.stop
      @wheel.stop
      @contextmenu.stop
    >
      <div
        class="sftp-dock-resize"
        title="Resize"
        @mousedown="onLocalDockResizeDown(d, $event)"
      />
      <LocalBrowser
        class="sftp-dock-browser"
        :target-tab-id="d.tabId"
        :fixed-label="d.label"
        can-close
        @close="togglePaneLocalDock(d.tabId)"
      />
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
    <TerminalScrollbar
      v-if="panes.length === 0 && !fullSftp && active && (active.kind === 'terminal' || active.kind === 'ssh')"
      :tab-id="active.id"
    />
    <!-- SFTP-only connection: the file browser is the whole tab. -->
    <div
      v-if="fullSftp"
      class="absolute inset-0 z-20"
      @mousedown.stop
      @wheel.stop
      @contextmenu.stop
    >
      <FilesPanel
        :tab-id="fullSftp.id"
        kind="ssh"
        hide-close
        class="h-full w-full"
      />
    </div>
    <slot />
    <!-- Hover header for plain terminal/SSH tabs: same grip + pill as
         workspace panes, but just the title and a file-browser toggle. -->
    <div
      v-if="panes.length === 0 && !fullSftp && active && (active.kind === 'terminal' || active.kind === 'ssh')"
      class="pane-hover"
    >
      <div class="pane-grip">⋯</div>
      <div class="pane-pill" :title="active.title">
        <span class="pane-title">{{ active.title }}</span>
        <button
          v-if="localTarget != null"
          type="button"
          class="pane-close"
          :class="{ 'pane-tool-on': showLocal }"
          :title="showLocal ? 'Hide file browser' : 'Show file browser'"
          @click="toggleLocalBrowser(localTarget)"
        >
          <PanelRight :size="12" :stroke-width="2.25" />
        </button>
        <button
          v-else-if="sftpTarget"
          type="button"
          class="pane-close"
          :class="{ 'pane-tool-on': showSftp }"
          :title="showSftp ? 'Hide file browser' : 'Show file browser'"
          @click="toggleSftpPanel(sftpTarget.id)"
        >
          <PanelRight :size="12" :stroke-width="2.25" />
        </button>
      </div>
    </div>
  </div>
  <!-- SFTP file browser: resizable divider + panel, SSH connections only. -->
  <template v-if="showSftp && sftpTarget">
    <div
      class="sftp-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize file browser"
      @mousedown="onSftpDividerDown"
    />
    <FilesPanel
      :tab-id="sftpTarget.id"
      kind="ssh"
      class="flex-none"
      :style="{
        width: `${sftpWidth}px`,
        margin: 'var(--frame-inset) var(--frame-inset) var(--frame-inset) 0',
        borderRadius: 'var(--pane-radius)',
        overflow: 'hidden',
      }"
      @close="toggleSftpPanel(sftpTarget.id)"
      @expand="onSftpExpand"
    />
  </template>
  <!-- Local file browser: resizable divider + panel, plain terminal tabs only. -->
  <template v-if="showLocal && localTarget != null">
    <div
      class="sftp-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize file browser"
      @mousedown="onLocalDividerDown"
    />
    <FilesPanel
      :tab-id="localTarget"
      kind="terminal"
      class="flex-none"
      :style="{
        width: `${localWidth}px`,
        margin: 'var(--frame-inset) var(--frame-inset) var(--frame-inset) 0',
        borderRadius: 'var(--pane-radius)',
        overflow: 'hidden',
      }"
      @close="toggleLocalBrowser(localTarget)"
      @expand="onLocalExpand"
    />
  </template>
  </div>
  <Teleport to="body">
    <div
      v-if="paneGhost"
      class="pane-drag-ghost"
      :style="{ left: `${paneGhost.x + 12}px`, top: `${paneGhost.y + 12}px` }"
    >
      {{ paneGhost.label }}
    </div>
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
}
/* Hover header: a centered grip hint + pill at the top of a terminal. Only
   this small centered strip captures the pointer; the rest of the top row
   stays interactive for the terminal beneath. */
.pane-hover {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  justify-content: center;
  padding: 4px 8px 6px;
  pointer-events: auto;
}
.pane-grip {
  position: absolute;
  top: 2px;
  left: 50%;
  transform: translateX(-50%);
  pointer-events: none;
  user-select: none;
  font-size: 11px;
  line-height: 1;
  letter-spacing: 1px;
  color: var(--fg-subtle, #9399b2);
  opacity: 0.6;
  transition: opacity 120ms ease;
}
.pane-hover:hover .pane-grip,
.pane-hover:active .pane-grip {
  opacity: 0;
}
.pane-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  max-width: 240px;
  padding: 0 4px 0 12px;
  box-sizing: border-box;
  border-radius: 9999px;
  user-select: none;
  font-size: 11px;
  color: var(--fg-muted, #cdd6f4);
  background: color-mix(in srgb, var(--surface-3, #313244) 88%, transparent);
  border: 1px solid
    color-mix(
      in srgb,
      var(--border-strong, rgba(255, 255, 255, 0.18)) 60%,
      transparent
    );
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  opacity: 0;
  transition: opacity 120ms ease;
}
.pane-hover:hover .pane-pill,
.pane-hover:active .pane-pill {
  opacity: 1;
}
.pane-pill-drag {
  cursor: grab;
}
.pane-pill-drag:active {
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
.pane-tool-on {
  color: var(--accent, #89b4fa);
}

/* Docked SFTP browser, overlaid on the bottom strip of an SSH pane. */
.sftp-dock {
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
.sftp-dock-browser {
  flex: 1;
  min-height: 0;
}
.sftp-dock-resize {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 6px;
  z-index: 1;
  cursor: row-resize;
  background: transparent;
  transition: background-color 120ms ease;
}
.sftp-dock-resize:hover,
.sftp-dock-resize:active {
  background: color-mix(in srgb, var(--accent, #89b4fa) 40%, transparent);
}
.pane-drag-ghost,
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

/* SFTP panel resize handle: a thin self-stretch bar between the terminal and
   the file browser. The visible line thickens on hover/drag. */
.sftp-divider {
  flex: none;
  width: 6px;
  align-self: stretch;
  margin: var(--frame-inset) 0;
  cursor: col-resize;
  border-radius: 9999px;
  background: transparent;
  transition: background-color 120ms ease;
}
.sftp-divider:hover,
.sftp-divider:active {
  background: color-mix(in srgb, var(--accent, #89b4fa) 40%, transparent);
}

</style>
