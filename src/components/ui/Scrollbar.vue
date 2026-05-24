<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, onMounted } from "vue";

// Generic, unit-agnostic scrollbar. The parent supplies position/range/
// viewportSize in whatever units it likes (rows for the terminal, pixels for
// DOM overflow elements) and we emit absolute scrollTo / discrete pageBy
// requests. Auto-hides while idle so it doesn't reserve a gutter — pair it
// with `position: relative/absolute` on the parent (when no `rect` is given)
// or with explicit pane coordinates.

const props = withDefaults(
  defineProps<{
    position: number;
    range: number;
    viewportSize: number;
    pageSize?: number;
    rect?: { x: number; y: number; w: number; h: number };
  }>(),
  {},
);

const emit = defineEmits<{
  (e: "scrollTo", position: number): void;
  (e: "pageBy", dir: -1 | 1): void;
}>();

const TRACK_INSET_PX = 4;
const TRACK_WIDTH_PX = 8;
const MIN_THUMB_PX = 24;
const IDLE_FADE_MS = 1000;

const trackEl = ref<HTMLDivElement | null>(null);
const trackPx = ref(0); // observed clientHeight of the track element
const hovered = ref(false);
const dragging = ref(false);
const idle = ref(true);

let idleTimer: number | null = null;
function bumpActivity(): void {
  idle.value = false;
  if (idleTimer != null) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    idle.value = true;
    idleTimer = null;
  }, IDLE_FADE_MS);
}

watch(
  () => props.position,
  () => bumpActivity(),
);

const hidden = computed(() => props.range <= 0);

const trackStyle = computed<Record<string, string | undefined>>(() => {
  if (props.rect) {
    return {
      left: `${props.rect.x + props.rect.w - TRACK_WIDTH_PX - TRACK_INSET_PX}px`,
      top: `${props.rect.y + TRACK_INSET_PX}px`,
      width: `${TRACK_WIDTH_PX}px`,
      height: `${props.rect.h - TRACK_INSET_PX * 2}px`,
    };
  }
  return {
    right: `${TRACK_INSET_PX}px`,
    top: `${TRACK_INSET_PX}px`,
    bottom: `${TRACK_INSET_PX}px`,
    width: `${TRACK_WIDTH_PX}px`,
  };
});

const thumbHeight = computed<number>(() => {
  const total = props.viewportSize + props.range;
  if (total <= 0) return MIN_THUMB_PX;
  const h = (trackPx.value * props.viewportSize) / total;
  return Math.max(MIN_THUMB_PX, Math.floor(h));
});

const thumbTop = computed<number>(() => {
  if (props.range <= 0) return 0;
  const usable = Math.max(0, trackPx.value - thumbHeight.value);
  return Math.round((props.position / props.range) * usable);
});

const visible = computed(
  () => !hidden.value && (!idle.value || hovered.value || dragging.value),
);

// ---- Drag the thumb -------------------------------------------------------

let dragOffsetY = 0; // cursor Y inside the thumb at drag start

function positionFromCursorY(clientY: number): number {
  const el = trackEl.value;
  if (!el) return props.position;
  const rect = el.getBoundingClientRect();
  const localY = clientY - rect.top - dragOffsetY;
  const usable = Math.max(1, trackPx.value - thumbHeight.value);
  const t = Math.max(0, Math.min(1, localY / usable));
  return Math.round(t * props.range);
}

function onThumbPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const target = e.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  dragOffsetY = e.clientY - rect.top;
  dragging.value = true;
  bumpActivity();
  target.setPointerCapture(e.pointerId);
  target.addEventListener("pointermove", onThumbPointerMove);
  target.addEventListener("pointerup", onThumbPointerUp);
  target.addEventListener("pointercancel", onThumbPointerUp);
}

function onThumbPointerMove(e: PointerEvent): void {
  if (!dragging.value) return;
  const next = positionFromCursorY(e.clientY);
  if (next !== props.position) emit("scrollTo", next);
  bumpActivity();
}

function onThumbPointerUp(e: PointerEvent): void {
  dragging.value = false;
  bumpActivity();
  const target = e.currentTarget as HTMLElement;
  try {
    target.releasePointerCapture(e.pointerId);
  } catch {
    /* pointer already released */
  }
  target.removeEventListener("pointermove", onThumbPointerMove);
  target.removeEventListener("pointerup", onThumbPointerUp);
  target.removeEventListener("pointercancel", onThumbPointerUp);
}

// ---- Click empty track to page -------------------------------------------

function onTrackPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const el = trackEl.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const localY = e.clientY - rect.top;
  // Above thumb → page up; below → page down. Inside the thumb the event is
  // stopped by the thumb's handler before it reaches here.
  if (localY < thumbTop.value) emit("pageBy", -1);
  else if (localY > thumbTop.value + thumbHeight.value) emit("pageBy", 1);
  bumpActivity();
}

let ro: ResizeObserver | null = null;

onMounted(() => {
  const el = trackEl.value;
  if (!el) return;
  trackPx.value = el.clientHeight;
  ro = new ResizeObserver(() => {
    if (trackEl.value) trackPx.value = trackEl.value.clientHeight;
  });
  ro.observe(el);
});

onBeforeUnmount(() => {
  if (idleTimer != null) window.clearTimeout(idleTimer);
  ro?.disconnect();
  ro = null;
});
</script>

<template>
  <div
    v-show="!hidden"
    ref="trackEl"
    class="absolute z-20 rounded-full transition-opacity duration-200"
    :class="visible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'"
    :style="{
      ...trackStyle,
      background:
        'color-mix(in srgb, var(--surface-3) 50%, transparent)',
    }"
    @pointerenter="hovered = true; bumpActivity()"
    @pointerleave="hovered = false"
    @pointerdown="onTrackPointerDown"
  >
    <div
      class="absolute left-0 right-0 rounded-full transition-colors duration-150 cursor-pointer"
      :style="{
        top: `${thumbTop}px`,
        height: `${thumbHeight}px`,
        background: dragging
          ? 'color-mix(in srgb, var(--fg-muted) 80%, transparent)'
          : 'color-mix(in srgb, var(--fg-muted) 45%, transparent)',
      }"
      @pointerdown="onThumbPointerDown"
    />
  </div>
</template>
