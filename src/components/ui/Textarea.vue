<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";

defineProps<{
  modelValue?: string;
  placeholder?: string;
  rows?: number | string;
  id?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const ta = ref<HTMLTextAreaElement | null>(null);
const pressed = ref(false);

function onPointerDown(e: PointerEvent) {
  if (!ta.value) return;
  const rect = ta.value.getBoundingClientRect();
  // Only react when the pointer is over the resize corner area.
  if (rect.right - e.clientX > 18 || rect.bottom - e.clientY > 18) return;
  pressed.value = true;
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
}

function onPointerUp() {
  pressed.value = false;
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", onPointerUp);
}

onMounted(() => {
  ta.value?.addEventListener("pointerdown", onPointerDown);
});

onBeforeUnmount(() => {
  ta.value?.removeEventListener("pointerdown", onPointerDown);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", onPointerUp);
});
</script>

<template>
  <div class="textarea-wrap relative">
    <textarea
      ref="ta"
      :id="id"
      :rows="rows"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      class="block w-full min-h-16 bg-surface-1 border border-border text-fg rounded-md px-2.5 py-2 font-mono text-xs resize-y focus:outline-none focus:border-border-strong"
      @input="
        emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)
      "
    />
    <svg
      class="grip pointer-events-none absolute bottom-1.5 right-1.5 text-fg-subtle"
      :class="{ 'is-pressed': pressed }"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
    >
      <line
        class="grip-outer"
        x1="1"
        y1="9"
        x2="9"
        y2="1"
        stroke="currentColor"
        stroke-width="1.25"
        stroke-linecap="round"
      />
      <line
        class="grip-inner"
        x1="5"
        y1="9"
        x2="9"
        y2="5"
        stroke="currentColor"
        stroke-width="1.25"
        stroke-linecap="round"
      />
    </svg>
  </div>
</template>

<style scoped>
textarea::-webkit-resizer {
  background: transparent;
}

.grip {
  overflow: visible;
}

/* Slight overshoot bezier mimics the spring feel without the rAF loop. */
.grip line {
  vector-effect: non-scaling-stroke;
  transform-box: fill-box;
  transform-origin: 50% 50%;
  transition:
    stroke-width 220ms cubic-bezier(0.34, 1.5, 0.6, 1),
    transform 220ms cubic-bezier(0.34, 1.5, 0.6, 1);
}
/* Outer line is heavier — slower morph. */
.grip-outer {
  transition-duration: 360ms, 360ms;
}
/* Inner line is lighter — snappier. */
.grip-inner {
  transition-duration: 220ms, 220ms;
}

.grip.is-pressed line {
  stroke-width: 2.75;
}
.grip.is-pressed .grip-outer {
  /* scale grows the outer line around its midpoint (5,5) so both ends reach
     further along the diagonal. */
  transform: translate(-1.5px, -1.5px) scale(1.25);
}
.grip.is-pressed .grip-inner {
  transform: translate(1px, 1px);
}

@media (prefers-reduced-motion: reduce) {
  .grip line {
    transition: none;
  }
}
</style>
