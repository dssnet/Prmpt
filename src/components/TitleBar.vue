<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { Lock, Minus, Square, Copy, X } from "lucide-vue-next";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type as osType } from "@tauri-apps/plugin-os";
import "slot-text/style.css";
import {
  animateSlotText,
  buildSlotText,
  clearSlotText,
  type SlotOptions,
} from "slot-text";
import { Tooltip } from "./ui";
import { isStrongholdLocked } from "../state/secrets";
import { useTabs } from "../state/tabs";

const { activeTitle } = useTabs();

const displayTitle = computed(() => activeTitle.value?.trim() || "Prmpt");

const REDUCED_MOTION =
  typeof matchMedia !== "undefined" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

// Terminal titles update in rapid bursts (shell preexec/precmd, programs
// animating their title), so `interrupt: false` lets each roll land and then
// rolls once more to the latest title instead of restarting mid-flight.
const titleRollOptions: SlotOptions = REDUCED_MOTION
  ? { duration: 0, stagger: 0, bounce: 0 }
  : { direction: "up", stagger: 15, skipUnchanged: true, interrupt: false };

// Zero durations = instant swap, but still routed through animateSlotText so
// it respects the interrupt:false queue (a tick arriving mid-roll plays after
// the roll lands instead of clobbering its DOM).
const instantSwapOptions: SlotOptions = {
  duration: 0,
  stagger: 0,
  bounce: 0,
  interrupt: false,
};

// True when the titles differ by at most one character (substitution,
// insertion, or deletion) — spinner frames, counter ticks, progress percent.
// Rolling a single glyph every tick is just noise, so those swap silently.
function isMinorEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (
    s < a.length - p &&
    s < b.length - p &&
    a[a.length - 1 - s] === b[b.length - 1 - s]
  )
    s++;
  return a.length - p - s <= 1 && b.length - p - s <= 1;
}

// Driven imperatively instead of via the SlotText component so we can pick
// the animation per change: full roll for real title changes, instant swap
// for one-character ticks.
const titleEl = ref<HTMLElement | null>(null);

onMounted(() => {
  if (titleEl.value) buildSlotText(titleEl.value, displayTitle.value);
});

watch(displayTitle, (next, prev) => {
  if (!titleEl.value) return;
  animateSlotText(
    titleEl.value,
    next,
    isMinorEdit(prev, next) ? instantSwapOptions : titleRollOptions,
  );
});

onUnmounted(() => {
  if (titleEl.value) clearSlotText(titleEl.value);
});

// macOS keeps its native traffic lights via the overlay titlebar; Linux
// uses the desktop environment's native window chrome, so on Linux we
// render nothing and let the OS titlebar handle title/drag/controls.
// Windows hides native chrome via `decorations(false)` and gets our
// custom buttons.
const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPod|iPad/.test(navigator.platform);
let IS_LINUX = false;
try {
  IS_LINUX = osType() === "linux";
} catch {
  // osType() can throw if the OS plugin isn't ready yet; assume non-Linux.
}
const renderTitleBar = !IS_LINUX;
const showWindowControls = !IS_MAC && !IS_LINUX;

const win = showWindowControls ? getCurrentWebviewWindow() : null;
const isMaximized = ref(false);
let unlistenResize: (() => void) | null = null;

onMounted(async () => {
  if (!win) return;
  isMaximized.value = await win.isMaximized();
  unlistenResize = await win.onResized(async () => {
    isMaximized.value = await win.isMaximized();
  });
});

onUnmounted(() => {
  unlistenResize?.();
  unlistenResize = null;
});

const onMinimize = () => {
  void win?.minimize();
};
const onToggleMaximize = () => {
  void win?.toggleMaximize();
};
const onClose = () => {
  void win?.close();
};
</script>

<template>
  <div
    v-if="renderTitleBar"
    data-tauri-drag-region
    class="flex-none h-titlebar relative bg-transparent select-none text-[11px] text-fg-subtle"
  >
    <div
      class="absolute inset-0 overflow-hidden pointer-events-none flex items-center justify-center px-2"
    >
      <span ref="titleEl" :aria-label="displayTitle"></span>
    </div>
    <!-- Guard over the traffic-lights area. Sits in front of the title so a
         long title slides behind this div instead of behind the native window
         controls. `bg-bg` matches the window's themed background. -->
    <div
      data-tauri-drag-region
      class="absolute left-0 top-0 bottom-0 bg-bg pointer-events-none"
      :style="{ width: 'var(--spacing-traffic-lights)' }"
    ></div>
    <!-- Status indicator: secrets store is unreachable (e.g. user dismissed the
         platform keychain prompt). Hidden when secrets are usable. The next
         secret IPC (boot openSecrets, SSH connect, save-from-dialog) flips
         the state via the wrappers in `src/secrets.ts`. -->
    <span
      v-if="isStrongholdLocked"
      class="absolute top-1/2 -translate-y-1/2 text-fg-muted"
      :class="showWindowControls ? 'right-32' : 'right-2'"
    >
      <Tooltip
        placement="bottom-end"
        text="Secrets locked — open a saved SSH host to retry the keychain prompt"
      >
        <span role="img" aria-label="Secrets locked" class="flex items-center">
          <Lock :size="12" />
        </span>
      </Tooltip>
    </span>
    <!-- Windows/Linux window controls. Native chrome is off on those
         platforms; macOS uses overlay traffic lights instead. The cluster
         has `bg-bg` so the centered title slides behind it instead of
         under the buttons. -->
    <div
      v-if="showWindowControls"
      class="absolute right-0 top-0 bottom-0 flex items-stretch bg-bg"
    >
      <button
        type="button"
        class="w-10 flex items-center justify-center text-fg-muted hover:bg-surface-2 transition-colors"
        aria-label="Minimize"
        @click="onMinimize"
      >
        <Minus :size="14" />
      </button>
      <button
        type="button"
        class="w-10 flex items-center justify-center text-fg-muted hover:bg-surface-2 transition-colors"
        :aria-label="isMaximized ? 'Restore' : 'Maximize'"
        @click="onToggleMaximize"
      >
        <component :is="isMaximized ? Copy : Square" :size="12" />
      </button>
      <button
        type="button"
        class="w-10 flex items-center justify-center text-fg-muted hover:bg-danger hover:text-white transition-colors"
        aria-label="Close"
        @click="onClose"
      >
        <X :size="14" />
      </button>
    </div>
  </div>
</template>
