<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Asterisk, Bell, ChevronDown, Columns2, Globe, X } from "lucide-vue-next";

import {
  HOME_TAB_ID,
  moveTab,
  setActive,
  useTabs,
  type TabState,
} from "../state/tabs";
import { requestCloseTab } from "../state/closeGuard";
import { bellTabs } from "../state/notifications";
import { resetTabConsumed } from "../state/workspace";
import NotificationCenter from "./NotificationCenter.vue";
import {
  clearWorkspaceDragPreview,
  commitWorkspaceDrop,
  pointOverTerminal,
  updateWorkspaceDragPreview,
} from "../state/terminal";

const props = defineProps<{
  onDragOut?: (tabId: number, screenX: number, screenY: number) => void;
}>();
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
  if (t.kind === "ssh") return t.hostLabel ?? "SSH";
  if (t.kind === "workspace") return "Workspace";
  return "Terminal";
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
// even over other windows (implicit capture).
const DRAG_OUT_THRESHOLD = 200; // screen px before a release tears off
const DRAG_START_PX = 5; // travel before a press becomes a drag

interface DragState {
  tabId: number;
  label: string;
  startScreenX: number;
  startScreenY: number;
  active: boolean;
  // Workspace tabs can be reordered but not torn off / split (v1 limit).
  reorderOnly: boolean;
  // The tab's own DOM node (stable across reorder — keyed by id), the grab
  // point within it, and its width, so it can ride under the cursor.
  el: HTMLElement;
  grabOffsetX: number;
  width: number;
}
let drag: DragState | null = null;
const ghost = ref<{ x: number; y: number; label: string } | null>(null);
let suppressClickUntil = 0;
let pointerX = 0;
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

// Glue the picked-up tab under the cursor every frame. It keeps its own DOM
// node (keyed by id) as the array reorders, so we just translate it from
// wherever the layout put it to where the cursor is holding it.
function dragFrame(): void {
  if (!drag || !drag.active || !pinnedEl) return;
  const el = pinnedEl;
  if (el.isConnected) {
    el.style.transform = "";
    const left = el.getBoundingClientRect().left;
    el.style.transform = `translateX(${Math.round(
      pointerX - drag.grabOffsetX - left,
    )}px)`;
  }
  rafId = requestAnimationFrame(dragFrame);
}

function startPin(): void {
  if (pinning || !drag) return;
  pinning = true;
  pinnedEl = drag.el;
  pinnedEl.classList.remove("tab-settle");
  pinnedEl.classList.add("tab-dragging");
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

// Where the dragged tab's center currently sits, vs. the other tabs' centers.
function computeReorderBeforeId(): number | null {
  if (!drag) return null;
  const centerX = pointerX - drag.grabOffsetX + drag.width / 2;
  for (const { id, el } of visibleTabEls()) {
    if (id === drag.tabId) continue; // skip the tab being carried
    const t = tabs.value.find((x) => x.id === id);
    if (!t || t.kind === "home") continue;
    const r = el.getBoundingClientRect();
    if (centerX < r.left + r.width / 2) return id;
  }
  return null; // past the last center → append
}

function applyLiveReorder(): void {
  if (!drag) return;
  const beforeId = computeReorderBeforeId();
  if (beforeId === drag.tabId) return; // dropping onto itself → no-op
  if (beforeId === lastReorderBeforeId) return; // slot unchanged
  lastReorderBeforeId = beforeId;
  moveTab(drag.tabId, beforeId);
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
    reorderOnly: t.kind === "workspace",
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
  pointerX = e.clientX;
  if (!drag.active) {
    const dx = e.screenX - drag.startScreenX;
    const dy = e.screenY - drag.startScreenY;
    if (dx * dx + dy * dy < DRAG_START_PX * DRAG_START_PX) return;
    drag.active = true;
    resetTabConsumed();
  }
  // Inside the bar: carry the tab under the cursor and reorder live.
  if (pointInTabBar(e.clientX, e.clientY)) {
    ghost.value = null;
    clearWorkspaceDragPreview();
    startPin();
    applyLiveReorder();
    return;
  }
  // Left the bar: drop the carried look. Re-arm the slot guard so re-entering
  // the bar recomputes from scratch.
  stopPin(false);
  lastReorderBeforeId = undefined;
  if (drag.reorderOnly) return; // workspace tabs only reorder (v1)
  // Outside the bar: original ghost + workspace-drop affordance.
  ghost.value = { x: e.clientX, y: e.clientY, label: drag.label };
  updateWorkspaceDragPreview(e.clientX, e.clientY, drag.tabId);
}

function onDragUp(e: MouseEvent): void {
  window.removeEventListener("mousemove", onDragMove);
  window.removeEventListener("mouseup", onDragUp);
  const d = drag;
  const inBar = !!d && pointInTabBar(e.clientX, e.clientY);
  stopPin(inBar); // settle into the slot if dropped in the bar
  drag = null;
  ghost.value = null;
  clearWorkspaceDragPreview();
  if (!d || !d.active) return; // never moved → it was a click
  // Swallow the click that follows this drag so it doesn't also switch tabs.
  suppressClickUntil = performance.now() + 300;

  // Released inside the bar → it was a reorder, already applied live.
  if (inBar) return;
  // Workspace tabs can't tear off / split in v1.
  if (d.reorderOnly) return;

  // Released over this window's terminal area → workspace split/merge.
  if (pointOverTerminal(e.clientX, e.clientY)) {
    commitWorkspaceDrop(d.tabId, e.clientX, e.clientY);
    return;
  }
  // Otherwise, far enough → tear off into a new / other window.
  const dx = e.screenX - d.startScreenX;
  const dy = e.screenY - d.startScreenY;
  if (dx * dx + dy * dy < DRAG_OUT_THRESHOLD * DRAG_OUT_THRESHOLD) return;
  props.onDragOut?.(d.tabId, e.screenX, e.screenY);
}

// The + button shares the tabs' mouse-driven drag (HTML5 DnD is unreliable in
// WKWebView). It has no DOM node to carry and no slot to reorder, so it's a
// trimmed version: just the ghost + workspace preview, resolving on release to
// a click, a workspace split, or a tear-off — App spawns the actual terminal.
interface PlusDrag {
  startScreenX: number;
  startScreenY: number;
  active: boolean;
}
let plusDrag: PlusDrag | null = null;

function onPlusMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return; // left button only
  plusDrag = {
    startScreenX: e.screenX,
    startScreenY: e.screenY,
    active: false,
  };
  window.addEventListener("mousemove", onPlusMove);
  window.addEventListener("mouseup", onPlusUp);
}

function onPlusMove(e: MouseEvent): void {
  if (!plusDrag) return;
  if (!plusDrag.active) {
    const dx = e.screenX - plusDrag.startScreenX;
    const dy = e.screenY - plusDrag.startScreenY;
    if (dx * dx + dy * dy < DRAG_START_PX * DRAG_START_PX) return;
    plusDrag.active = true;
    resetTabConsumed();
  }
  // Inside the bar: no affordance — releasing here is just "new tab".
  if (pointInTabBar(e.clientX, e.clientY)) {
    ghost.value = null;
    clearWorkspaceDragPreview();
    return;
  }
  // Outside the bar: ghost + the same workspace drop highlight tabs show.
  ghost.value = { x: e.clientX, y: e.clientY, label: "New terminal" };
  updateWorkspaceDragPreview(e.clientX, e.clientY);
}

function onPlusUp(e: MouseEvent): void {
  window.removeEventListener("mousemove", onPlusMove);
  window.removeEventListener("mouseup", onPlusUp);
  const d = plusDrag;
  plusDrag = null;
  ghost.value = null;
  clearWorkspaceDragPreview();
  // Never moved (or dropped back in the bar) → a plain new tab.
  if (!d || !d.active || pointInTabBar(e.clientX, e.clientY)) {
    emit("requestNewTab");
    return;
  }
  // Over this window's terminal → spawn + split into the workspace there.
  if (pointOverTerminal(e.clientX, e.clientY)) {
    emit("newTabWorkspace", e.clientX, e.clientY);
    return;
  }
  // Far enough out → spawn into a new / other window.
  const dx = e.screenX - d.startScreenX;
  const dy = e.screenY - d.startScreenY;
  if (dx * dx + dy * dy >= DRAG_OUT_THRESHOLD * DRAG_OUT_THRESHOLD) {
    emit("newTabWindow", e.screenX, e.screenY);
    return;
  }
  // Small drag that left the bar but landed nowhere meaningful → new tab.
  emit("requestNewTab");
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
  if (!menuOpen.value) return;
  const target = e.target as Node | null;
  if (!target) return;
  if (menuEl.value?.contains(target)) return;
  if (triggerEl.value?.contains(target)) return;
  menuOpen.value = false;
}
function onKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape" && menuOpen.value) menuOpen.value = false;
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
});

onBeforeUnmount(() => {
  resizeObs?.disconnect();
  document.removeEventListener("mousedown", onDocMouseDown);
  document.removeEventListener("keydown", onKeyDown);
});

watch(overflowTabs, (n) => {
  if (n.length === 0) menuOpen.value = false;
});
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
      <Transition name="overflow-panel">
        <div
          v-if="menuOpen"
          ref="menuEl"
          class="overflow-panel absolute left-0 top-full mt-1 min-w-45 max-w-70 z-50 rounded-lg bg-surface-1 ring-1 ring-border-strong shadow-[0_8px_24px_rgba(0,0,0,0.35)] p-1 text-xs"
        >
          <button
            v-for="t in overflowTabs"
            :key="t.id"
            type="button"
            :class="[
              'group w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-left cursor-pointer',
              active?.id === t.id
                ? 'bg-surface-2 text-fg'
                : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
            ]"
            @click="pickOverflow(t)"
            @mousedown.middle.prevent="onMiddleClose(t)"
          >
            <Globe
              v-if="t.kind === 'ssh'"
              :size="12"
              class="flex-none text-fg-subtle"
            />
            <Columns2
              v-else-if="t.kind === 'workspace'"
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
      class="flex-initial min-w-0 overflow-hidden"
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
        >
          <Globe
            v-if="t.kind === 'ssh'"
            :size="13"
            class="flex-none mr-1 text-fg-muted"
          />
          <Columns2
            v-else-if="t.kind === 'workspace'"
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
    <div
      title="New tab (⌘T) — drag onto the terminal to split, or out for a new window"
      class="flex-none flex items-center justify-center w-6 h-6 rounded-full text-fg-subtle cursor-pointer text-sm leading-none bg-surface-1 hover:bg-surface-2 hover:text-fg transition-colors duration-100"
      @mousedown="onPlusMouseDown"
    >
      +
    </div>
    <NotificationCenter class="ml-auto" />
  </div>
  <Teleport to="body">
    <div
      v-if="ghost"
      class="tab-drag-ghost"
      :style="{ left: `${ghost.x + 12}px`, top: `${ghost.y + 12}px` }"
    >
      {{ ghost.label }}
    </div>
  </Teleport>
</template>

<style scoped>
.tab-drag-ghost {
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
</style>

<style scoped>
/* Overflow dropdown: chevron rotation + panel pop. */
.overflow-chevron {
  transition: transform 200ms cubic-bezier(0.34, 1.5, 0.6, 1);
}
.overflow-chevron.is-open {
  transform: rotate(180deg);
}
.overflow-panel {
  transform-origin: top left;
}
.overflow-panel-enter-active {
  transition:
    transform 200ms cubic-bezier(0.34, 1.5, 0.6, 1),
    opacity 160ms ease-out;
}
.overflow-panel-leave-active {
  transition:
    transform 120ms ease-in,
    opacity 100ms ease-in;
}
.overflow-panel-enter-from,
.overflow-panel-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(-6px);
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
  opacity: 0.97;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  pointer-events: none;
  will-change: transform;
}

/* On drop, glide from the cursor to the resolved slot instead of snapping. */
.tab-settle {
  transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1) !important;
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
