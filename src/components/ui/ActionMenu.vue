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
    <!-- Look/motion from the shared `.pop-panel` recipe + `pop` transition
         in styles.css. -->
    <Transition name="pop">
      <div
        v-if="open"
        role="menu"
        class="pop-panel origin-top-right absolute right-0 top-[calc(100%+4px)] z-50 min-w-36 p-1 flex flex-col"
      >
        <slot :close="close" />
      </div>
    </Transition>
  </div>
</template>
