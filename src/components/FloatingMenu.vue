<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

import {
  closeFloatingMenu,
  floatingMenu,
  type FloatingMenuItem,
} from "../state/floatingMenu";

// Cursor-positioned context menu with one level of submenus and per-item
// hover callbacks (see state/floatingMenu.ts). Rendered once, globally.

const VIEWPORT_PAD = 8;
const MENU_MIN_W = 180;

const rootEl = ref<HTMLElement | null>(null);
const pos = ref<{ x: number; y: number }>({ x: 0, y: 0 });

// Index of the top-level item whose submenu is open, and the flyout's anchor.
const openSubIdx = ref<number | null>(null);
const subPos = ref<{ x: number; y: number; flip: boolean } | null>(null);

// The item currently under the pointer (top-level or submenu child), so we can
// pair onHover / onLeave precisely.
let hovered: FloatingMenuItem | null = null;
function setHovered(item: FloatingMenuItem | null): void {
  if (hovered === item) return;
  hovered?.onLeave?.();
  hovered = item;
  hovered?.onHover?.();
}

function close(): void {
  setHovered(null);
  openSubIdx.value = null;
  subPos.value = null;
  closeFloatingMenu();
}

function runItem(item: FloatingMenuItem): void {
  if (item.disabled || item.submenu) return;
  item.action?.();
  close();
}

// ---- top-level item hover: open/close the submenu, fire hover callbacks ----
function onItemEnter(item: FloatingMenuItem, idx: number, el: HTMLElement): void {
  setHovered(item);
  if (item.submenu && item.submenu.length) {
    const r = el.getBoundingClientRect();
    const subW = MENU_MIN_W;
    const flip = r.right + subW + VIEWPORT_PAD > window.innerWidth;
    subPos.value = {
      x: flip ? r.left - subW + 2 : r.right - 2,
      y: r.top,
      flip,
    };
    openSubIdx.value = idx;
  } else {
    openSubIdx.value = null;
    subPos.value = null;
  }
}

function onSubItemEnter(item: FloatingMenuItem): void {
  setHovered(item);
}

// ---- viewport clamping -----------------------------------------------------
function reposition(): void {
  const m = floatingMenu.value;
  if (!m) return;
  const el = rootEl.value;
  const w = el?.offsetWidth ?? MENU_MIN_W;
  const h = el?.offsetHeight ?? 0;
  pos.value = {
    x: Math.max(VIEWPORT_PAD, Math.min(m.x, window.innerWidth - w - VIEWPORT_PAD)),
    y: Math.max(VIEWPORT_PAD, Math.min(m.y, window.innerHeight - h - VIEWPORT_PAD)),
  };
}

watch(
  floatingMenu,
  (m) => {
    if (!m) {
      setHovered(null);
      return;
    }
    pos.value = { x: m.x, y: m.y };
    openSubIdx.value = null;
    subPos.value = null;
    void nextTick(reposition);
  },
  { immediate: true },
);

// Clamp the submenu flyout vertically once it has measured.
const subEl = ref<HTMLElement | null>(null);
watch(openSubIdx, () =>
  nextTick(() => {
    const el = subEl.value;
    const sp = subPos.value;
    if (!el || !sp) return;
    const h = el.offsetHeight;
    if (sp.y + h + VIEWPORT_PAD > window.innerHeight) {
      subPos.value = { ...sp, y: Math.max(VIEWPORT_PAD, window.innerHeight - h - VIEWPORT_PAD) };
    }
  }),
);

// ---- dismissal -------------------------------------------------------------
function onDocPointerDown(e: PointerEvent): void {
  if (rootEl.value && rootEl.value.contains(e.target as Node)) return;
  if (subEl.value && subEl.value.contains(e.target as Node)) return;
  close();
}
function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}
function onScroll(): void {
  close();
}

watch(
  () => floatingMenu.value != null,
  (open) => {
    if (open) {
      document.addEventListener("pointerdown", onDocPointerDown, true);
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("blur", close);
      window.addEventListener("resize", close);
      window.addEventListener("wheel", onScroll, true);
    } else {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", onScroll, true);
    }
  },
);

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", close);
  window.removeEventListener("resize", close);
  window.removeEventListener("wheel", onScroll, true);
});

const items = computed(() => floatingMenu.value?.items ?? []);
const submenuItems = computed(() => {
  const i = openSubIdx.value;
  if (i == null) return [];
  const it = items.value[i];
  return it && "submenu" in it ? (it.submenu ?? []) : [];
});
</script>

<template>
  <Teleport to="body">
    <template v-if="floatingMenu">
      <div
        ref="rootEl"
        class="fm-panel"
        :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
        @contextmenu.prevent
      >
        <template v-for="(it, idx) in items" :key="idx">
          <div v-if="it === null" class="fm-sep" />
          <button
            v-else
            type="button"
            class="fm-item"
            :class="{
              'fm-danger': it.danger,
              'fm-disabled': it.disabled,
              'fm-open': openSubIdx === idx,
            }"
            :disabled="it.disabled"
            @mouseenter="onItemEnter(it, idx, $event.currentTarget as HTMLElement)"
            @click="runItem(it)"
          >
            <component :is="it.icon" v-if="it.icon" :size="14" class="fm-icon" />
            <span class="fm-text">{{ it.text }}</span>
            <span v-if="it.submenu && it.submenu.length" class="fm-caret">›</span>
          </button>
        </template>
      </div>
      <div
        v-if="subPos && submenuItems.length"
        ref="subEl"
        class="fm-panel fm-submenu"
        :style="{ left: `${subPos.x}px`, top: `${subPos.y}px` }"
        @contextmenu.prevent
      >
        <button
          v-for="(sit, si) in submenuItems"
          :key="si"
          type="button"
          class="fm-item"
          :class="{ 'fm-disabled': sit.disabled }"
          :disabled="sit.disabled"
          @mouseenter="onSubItemEnter(sit)"
          @click="runItem(sit)"
        >
          <component :is="sit.icon" v-if="sit.icon" :size="14" class="fm-icon" />
          <span class="fm-text">{{ sit.text }}</span>
        </button>
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
.fm-panel {
  position: fixed;
  z-index: 9999;
  min-width: 180px;
  max-width: 320px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  background: var(--surface-1, #1e1e2e);
  border: 1px solid var(--border-strong, rgba(255, 255, 255, 0.18));
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  user-select: none;
}
.fm-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 5px 9px;
  border-radius: 6px;
  font-size: 13px;
  text-align: left;
  color: var(--fg-muted, #cdd6f4);
  cursor: default;
  white-space: nowrap;
}
.fm-item:hover:not(.fm-disabled),
.fm-item.fm-open {
  background: color-mix(in srgb, var(--accent, #89b4fa) 22%, transparent);
  color: var(--fg, #e6e6e6);
}
.fm-icon {
  flex: none;
  color: var(--fg-subtle, #9399b2);
}
.fm-item:hover:not(.fm-disabled) .fm-icon,
.fm-item.fm-open .fm-icon {
  color: inherit;
}
.fm-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fm-caret {
  flex: none;
  color: var(--fg-subtle, #9399b2);
  font-size: 14px;
  line-height: 1;
}
.fm-danger {
  color: var(--color-danger, #f38ba8);
}
.fm-danger:hover:not(.fm-disabled) {
  background: color-mix(in srgb, var(--color-danger, #f38ba8) 22%, transparent);
  color: var(--color-danger, #f38ba8);
}
.fm-disabled {
  opacity: 0.4;
  cursor: default;
}
.fm-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border, #313244);
}
</style>
