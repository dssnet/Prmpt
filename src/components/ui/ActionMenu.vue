<script setup lang="ts">
import { MoreHorizontal } from "lucide-vue-next";
import { onBeforeUnmount, ref, watch } from "vue";

withDefaults(
  defineProps<{
    title?: string;
  }>(),
  { title: "More actions" },
);

const root = ref<HTMLElement | null>(null);
const open = ref(false);

function close() {
  open.value = false;
}

function toggle() {
  open.value = !open.value;
}

function onDocPointer(e: PointerEvent) {
  if (!open.value) return;
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}

function onKey(e: KeyboardEvent) {
  if (open.value && e.key === "Escape") {
    e.preventDefault();
    open.value = false;
  }
}

watch(open, (v) => {
  if (v) {
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("keydown", onKey, true);
  } else {
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onKey, true);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointer, true);
  document.removeEventListener("keydown", onKey, true);
});
</script>

<template>
  <div ref="root" class="relative">
    <slot name="trigger" :open="open" :toggle="toggle">
      <button
        type="button"
        :title="title"
        :aria-haspopup="'menu'"
        :aria-expanded="open"
        class="inline-flex items-center justify-center px-2.5 py-1 rounded-md border bg-transparent text-fg-muted cursor-pointer transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
        :class="open ? 'border-border-strong text-fg' : 'border-border'"
        @click="toggle"
      >
        <MoreHorizontal :size="14" />
      </button>
    </slot>
    <Transition name="dropdown-panel">
      <div
        v-if="open"
        role="menu"
        class="dropdown-panel absolute right-0 top-[calc(100%+4px)] z-50 min-w-36 bg-surface-1 border border-border-strong rounded-lg p-1 shadow-[0_8px_24px_rgba(0,0,0,0.35)] flex flex-col"
      >
        <slot :close="close" />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.dropdown-panel {
  transform-origin: top right;
}
.dropdown-panel-enter-active {
  transition:
    transform 200ms cubic-bezier(0.34, 1.5, 0.6, 1),
    opacity 160ms ease-out;
}
.dropdown-panel-leave-active {
  transition:
    transform 120ms ease-in,
    opacity 100ms ease-in;
}
.dropdown-panel-enter-from,
.dropdown-panel-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(-6px);
}

@media (prefers-reduced-motion: reduce) {
  .dropdown-panel-enter-active,
  .dropdown-panel-leave-active {
    transition: none;
  }
}
</style>
