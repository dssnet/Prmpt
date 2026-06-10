<script setup lang="ts">
import { ref, onBeforeUnmount } from "vue";
import { ChevronUp, ChevronDown } from "lucide-vue-next";

type InputType =
  | "text"
  | "password"
  | "number"
  | "email"
  | "url"
  | "tel"
  | "search"
  | "file"
  | "color";

const props = withDefaults(
  defineProps<{
    modelValue?: string | number;
    type?: InputType;
    placeholder?: string;
    min?: number | string;
    max?: number | string;
    id?: string;
    disabled?: boolean;
    autocomplete?: string;
    spellcheck?: boolean;
    /** "sm" is a compact variant for tight chrome (toolbar/header rows). */
    size?: "md" | "sm";
  }>(),
  { type: "text", size: "md" },
);

const emit = defineEmits<{
  "update:modelValue": [value: string | number];
}>();

const pulseKey = ref(0);

function onInput(e: Event, asNumber: boolean) {
  const v = (e.target as HTMLInputElement).value;
  emit("update:modelValue", asNumber ? Number(v) || 0 : v);
}

let holdTimer: number | undefined;
let intervalSpeed = 0;

let lastWheel = 0;
function onWheel(e: WheelEvent) {
  if (props.type !== "number") return;
  // Only intercept when this input is focused, so background pages still scroll.
  if (e.currentTarget !== document.activeElement) return;
  e.preventDefault();
  const now = performance.now();
  if (now - lastWheel < 40) return;
  lastWheel = now;
  step(e.deltaY < 0 ? 1 : -1);
}

function step(dir: 1 | -1) {
  if (props.disabled) return;
  const current = Number(props.modelValue) || 0;
  let next = current + dir;
  if (props.min != null) next = Math.max(Number(props.min), next);
  if (props.max != null) next = Math.min(Number(props.max), next);
  if (next === current) return;
  emit("update:modelValue", next);
  pulseKey.value++;
}

function startHold(dir: 1 | -1, e: Event) {
  e.preventDefault();
  step(dir);
  intervalSpeed = 240;
  const tick = () => {
    step(dir);
    intervalSpeed = Math.max(40, intervalSpeed * 0.82);
    holdTimer = window.setTimeout(tick, intervalSpeed);
  };
  holdTimer = window.setTimeout(tick, 380);
  window.addEventListener("pointerup", stopHold);
  window.addEventListener("pointercancel", stopHold);
}

function stopHold() {
  if (holdTimer !== undefined) {
    clearTimeout(holdTimer);
    holdTimer = undefined;
  }
  window.removeEventListener("pointerup", stopHold);
  window.removeEventListener("pointercancel", stopHold);
}

onBeforeUnmount(stopHold);
</script>

<template>
  <div
    class="num-wrap"
    :class="{ 'is-number': type === 'number' }"
    :data-pulse="pulseKey"
  >
    <input
      :id="id"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      :min="min"
      :max="max"
      :disabled="disabled"
      :autocomplete="autocomplete"
      :spellcheck="spellcheck"
      class="num-input flex-1 w-full bg-surface-1 border border-border text-fg rounded-md focus:outline-none focus:border-border-strong disabled:opacity-50"
      :class="size === 'sm' ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-1.5 text-sm'"
      @input="onInput($event, type === 'number')"
      @wheel="onWheel"
    />
    <div v-if="type === 'number'" class="chevrons" aria-hidden="true">
      <button
        type="button"
        class="chev"
        tabindex="-1"
        :disabled="disabled"
        @pointerdown="startHold(1, $event)"
      >
        <ChevronUp :size="12" :stroke-width="2.5" />
      </button>
      <button
        type="button"
        class="chev"
        tabindex="-1"
        :disabled="disabled"
        @pointerdown="startHold(-1, $event)"
      >
        <ChevronDown :size="12" :stroke-width="2.5" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.num-wrap {
  position: relative;
  display: flex;
  flex: 1;
}

/* Hide native spinner for number type. */
.num-wrap.is-number .num-input {
  padding-right: 22px;
  appearance: textfield;
  -moz-appearance: textfield;
}
.num-wrap.is-number .num-input::-webkit-inner-spin-button,
.num-wrap.is-number .num-input::-webkit-outer-spin-button {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
}

.chevrons {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 1px;
  pointer-events: auto;
}

.chev {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 11px;
  padding: 0;
  margin: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--fg-subtle);
  border-radius: 3px;
  transition:
    color 140ms ease,
    transform 180ms cubic-bezier(0.34, 1.6, 0.5, 1),
    background-color 140ms ease;
}
.chev:hover {
  color: var(--fg-muted);
  background: color-mix(in srgb, var(--fg) 8%, transparent);
}
.chev:active {
  transform: scale(1.35);
}
.chev:disabled {
  opacity: 0.4;
  cursor: default;
}

/* Pulse: keyframed accent ring + nudge each time pulseKey changes.
   data-attribute animation trick — changing the attribute restarts the
   animation without us managing timers/classes in JS. */
.num-wrap.is-number[data-pulse] .num-input {
  animation: step-pulse 260ms ease-out;
}
@keyframes step-pulse {
  0% {
    box-shadow: 0 0 0 0 transparent;
    border-color: var(--border);
  }
  40% {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 28%, transparent);
    border-color: var(--accent);
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
    border-color: var(--border);
  }
}

@media (prefers-reduced-motion: reduce) {
  .chev,
  .num-input {
    transition: none;
    animation: none !important;
  }
}
</style>
