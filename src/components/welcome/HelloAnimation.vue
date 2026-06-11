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
    viewBox="22 22 292 162"
    fill="none"
    class="w-[min(60vw,480px)] text-fg"
    role="img"
    aria-label="hello"
  >
    <!-- Single-stroke cursive "hello", hand-authored. One continuous path so
         the dash-offset draw reads as handwriting. Baseline y=168,
         x-height ~115, ascender loops to ~35, 12° italic slant baked into
         the coordinates (anchored at the baseline). -->
    <path
      ref="pathEl"
      d="M 34.4 166
         C 57.7 132, 85.6 76, 96.2 54
         C 103.6 38, 92.5 34, 84.1 50
         C 71.7 80, 59.9 126, 51.6 165
         C 50.1 172, 52.7 174, 57.4 166
         C 67.1 144, 80.8 122, 94.3 115
         C 107.5 109, 114.1 116, 111.1 130
         C 108.1 144, 104.6 156, 103.3 162
         C 101.4 171, 106.9 173, 116.1 163
         C 130.7 146, 149.9 126, 162.6 118
         C 175.9 98, 153.7 94, 141.9 112
         C 131.3 129, 126.8 150, 134.5 161
         C 140.6 170, 155.9 164, 169 149
         C 191.8 122, 219.4 72, 229.7 52
         C 237.1 36, 224.7 33, 216.1 50
         C 203.7 80, 190.9 126, 183.1 163
         C 181.1 172, 186.7 174, 196.3 162
         C 227.2 120, 256.4 72, 266.7 52
         C 274.1 36, 261.7 33, 253.1 50
         C 240.7 80, 227.9 126, 220.1 163
         C 218.1 172, 223.7 174, 233.5 161
         C 248 140, 263.8 122, 277.5 114
         C 270.5 109, 259.7 113, 253.9 126
         C 248.4 138, 247.4 152, 253.1 158
         C 259.9 164, 271.5 161, 278.8 150
         C 284.7 141, 287.5 128, 283.6 118
         C 288.5 109, 296.3 110, 302.1 116"
      stroke="currentColor"
      stroke-width="6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>
