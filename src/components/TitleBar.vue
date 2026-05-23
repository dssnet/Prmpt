<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Lock, Minus, Square, Copy, X } from "lucide-vue-next";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Tooltip } from "./ui";
import { isStrongholdLocked } from "../state/secrets";
import { useTabs } from "../state/tabs";

const { activeTitle } = useTabs();

const displayTitle = computed(() => activeTitle.value?.trim() || "Prmpt");
// Array.from splits on Unicode code points so surrogate-pair emoji survive intact.
const titleChars = computed(() => Array.from(displayTitle.value));

const STAGGER_MS = 22;
// Beyond this index, chars share the last delay slot so a long title doesn't
// take well over a second to finish landing.
const STAGGER_CAP = 16;
const ENTER_BASE_MS = 320;
const LEAVE_MS = 180;

const transitionDuration = computed(() => {
  const lastIdx = Math.min(Math.max(0, titleChars.value.length - 1), STAGGER_CAP);
  return {
    enter: ENTER_BASE_MS + lastIdx * STAGGER_MS,
    leave: LEAVE_MS,
  };
});

// macOS keeps its native traffic lights via the overlay titlebar; everywhere
// else the native chrome is hidden (`decorations(false)` in the Rust window
// builders) so we draw our own minimize/maximize/close.
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPod|iPad/.test(navigator.platform);
const showWindowControls = !IS_MAC;

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
    data-tauri-drag-region
    class="flex-none h-titlebar relative bg-transparent select-none text-[11px] text-fg-subtle"
  >
    <div class="absolute inset-0 overflow-hidden pointer-events-none">
      <Transition name="title-wave" :duration="transitionDuration">
        <span
          :key="displayTitle"
          class="absolute inset-0 flex items-center justify-center px-2 whitespace-nowrap"
        >
          <span
            v-for="(ch, i) in titleChars"
            :key="i"
            class="title-char inline-block"
            :style="{ '--i': Math.min(i, STAGGER_CAP) }"
          >{{ ch === " " ? " " : ch }}</span>
        </span>
      </Transition>
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
      :class="showWindowControls ? 'right-[128px]' : 'right-2'"
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

<style scoped>
.title-char {
  animation-fill-mode: both;
  transform-origin: 50% 60%;
}

.title-wave-enter-active .title-char {
  animation-name: title-wave-in;
  animation-duration: 320ms;
  /* gentle spring — peaks ~1.04 around t=0.6 then settles */
  animation-timing-function: cubic-bezier(0.34, 1.55, 0.5, 1);
  animation-delay: calc(var(--i, 0) * 22ms);
}

.title-wave-leave-active .title-char {
  animation-name: title-wave-out;
  animation-duration: 180ms;
  animation-timing-function: cubic-bezier(0.4, 0, 1, 1);
}

@keyframes title-wave-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.85);
    filter: blur(2px);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
    filter: blur(0);
  }
}

@keyframes title-wave-out {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
    filter: blur(0);
  }
  to {
    opacity: 0;
    transform: translateY(-6px) scale(0.95);
    filter: blur(2px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .title-wave-enter-active .title-char,
  .title-wave-leave-active .title-char {
    animation: none;
  }
}
</style>
