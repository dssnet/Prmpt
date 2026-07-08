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
    <Transition name="pop">
      <div
        v-if="floatingMenu"
        ref="rootEl"
        class="fm-panel pop-panel origin-top-left"
        :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
        @contextmenu.prevent
      >
        <template v-for="(it, idx) in items" :key="idx">
          <div v-if="it === null" class="my-1 h-px bg-border-strong/60" />
          <!-- Same row recipe as the tab-bar menus (TabBar.vue) — keep the
               two in sync so context menus and dropdowns look identical. -->
          <button
            v-else
            type="button"
            class="pop-item w-full flex items-center gap-2 px-2 py-1 rounded-md text-left text-xs whitespace-nowrap"
            :class="
              it.disabled
                ? 'text-fg-subtle opacity-50 cursor-default'
                : it.danger
                  ? 'text-danger hover:bg-danger/20 cursor-pointer'
                  : openSubIdx === idx
                    ? 'bg-surface-2 text-fg cursor-pointer'
                    : 'text-fg-muted hover:bg-surface-2 hover:text-fg cursor-pointer'
            "
            :style="{ '--i': idx }"
            :disabled="it.disabled"
            @mouseenter="onItemEnter(it, idx, $event.currentTarget as HTMLElement)"
            @click="runItem(it)"
          >
            <component
              :is="it.icon"
              v-if="it.icon"
              :size="13"
              class="flex-none"
              :class="it.danger && !it.disabled ? '' : 'text-fg-subtle'"
            />
            <span class="flex-1 overflow-hidden text-ellipsis">{{ it.text }}</span>
            <span
              v-if="it.submenu && it.submenu.length"
              class="flex-none text-sm leading-none text-fg-subtle"
              >›</span
            >
          </button>
        </template>
      </div>
    </Transition>
    <Transition name="pop">
      <div
        v-if="subPos && submenuItems.length"
        ref="subEl"
        class="fm-panel pop-panel"
        :class="subPos.flip ? 'origin-top-right' : 'origin-top-left'"
        :style="{ left: `${subPos.x}px`, top: `${subPos.y}px` }"
        @contextmenu.prevent
      >
        <button
          v-for="(sit, si) in submenuItems"
          :key="si"
          type="button"
          class="pop-item w-full flex items-center gap-2 px-2 py-1 rounded-md text-left text-xs whitespace-nowrap"
          :class="
            sit.disabled
              ? 'text-fg-subtle opacity-50 cursor-default'
              : 'text-fg-muted hover:bg-surface-2 hover:text-fg cursor-pointer'
          "
          :style="{ '--i': si }"
          :disabled="sit.disabled"
          @mouseenter="onSubItemEnter(sit)"
          @click="runItem(sit)"
        >
          <component :is="sit.icon" v-if="sit.icon" :size="13" class="flex-none text-fg-subtle" />
          <span class="flex-1 overflow-hidden text-ellipsis">{{ sit.text }}</span>
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* Look and enter/leave motion come from the shared `.pop-panel` recipe +
   `pop` transition in styles.css; row styling is Tailwind utilities in the
   template (same classes as the tab-bar menus). Only menu-specific layout
   lives here. */
.fm-panel {
  position: fixed;
  z-index: 9999;
  min-width: 180px;
  max-width: 320px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  user-select: none;
}
</style>
