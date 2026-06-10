<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = withDefaults(defineProps<{ durationMs?: number }>(), {
  durationMs: 2600,
});

const emit = defineEmits<{ done: [] }>();

const pathEl = ref<SVGPathElement | null>(null);

let fallback: ReturnType<typeof setTimeout> | undefined;
let finished = false;

function finish(): void {
  if (finished) return;
  finished = true;
  if (fallback !== undefined) clearTimeout(fallback);
  emit("done");
}

onMounted(() => {
  const path = pathEl.value;
  if (!path) {
    finish();
    return;
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    // Render fully drawn, no animation.
    finish();
    return;
  }
  // Classic stroke-draw: dash the path to its own length, then transition
  // the offset to 0. Measuring via getTotalLength() means the path data
  // can be re-authored freely without touching this code.
  const len = path.getTotalLength();
  path.style.strokeDasharray = `${len}`;
  path.style.strokeDashoffset = `${len}`;
  // Force a reflow so the dash setup commits before the transition starts.
  path.getBoundingClientRect();
  path.style.transition = `stroke-dashoffset ${props.durationMs}ms ease-in-out`;
  path.style.strokeDashoffset = "0";
  path.addEventListener("transitionend", finish, { once: true });
  fallback = setTimeout(finish, props.durationMs + 200);
});

onBeforeUnmount(() => {
  if (fallback !== undefined) clearTimeout(fallback);
});
</script>

<template>
  <svg
    viewBox="0 0 232 200"
    fill="none"
    class="w-[min(55vw,440px)] text-fg"
    role="img"
    aria-label="hello"
  >
    <!-- Single-stroke cursive "hello", hand-authored. One continuous path so
         the dash-offset draw reads as handwriting. -->
    <path
      ref="pathEl"
      d="M 20 120
         C 28 102, 40 72, 46 58
         C 49 46, 47 38, 42 40
         C 36 42, 35 60, 34 82
         C 33 110, 33 138, 34 150
         C 35 158, 38 158, 40 150
         C 43 134, 48 112, 58 107
         C 66 103, 71 108, 71 118
         C 71 132, 70 142, 70 150
         C 70 158, 76 158, 80 148
         C 86 136, 96 120, 103 108
         C 106 99, 98 95, 93 104
         C 89 112, 87 127, 91 140
         C 95 152, 106 154, 116 144
         C 124 128, 136 100, 141 76
         C 144 58, 142 46, 136 46
         C 130 46, 129 64, 128 84
         C 127 112, 126 140, 127 150
         C 128 158, 134 159, 140 150
         C 148 128, 162 100, 167 76
         C 170 58, 168 46, 162 46
         C 156 46, 155 64, 154 84
         C 153 112, 152 140, 153 150
         C 154 158, 160 159, 166 150
         C 170 140, 180 118, 192 110
         C 204 104, 212 114, 212 128
         C 212 144, 202 156, 190 156
         C 178 156, 172 146, 174 132
         C 176 119, 184 111, 192 110
         C 197 107, 205 113, 213 107"
      stroke="currentColor"
      stroke-width="6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>
