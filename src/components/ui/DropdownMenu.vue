<script setup lang="ts">
import { Asterisk, ChevronDown } from "lucide-vue-next";
import { computed, onBeforeUnmount, ref, watch } from "vue";

type OptionValue = string | number;
type Option = { value: OptionValue; label: string; disabled?: boolean };

const props = withDefaults(
  defineProps<{
    modelValue?: OptionValue;
    options: Option[];
    id?: string;
    disabled?: boolean;
    placeholder?: string;
    /** "sm" is a compact variant for tight chrome (toolbar/header rows). */
    size?: "md" | "sm";
  }>(),
  { size: "md" },
);

const emit = defineEmits<{ "update:modelValue": [value: OptionValue] }>();

const root = ref<HTMLElement | null>(null);
const open = ref(false);
const activeIndex = ref(-1);

const selected = computed(() =>
  props.options.find((o) => String(o.value) === String(props.modelValue)),
);
const buttonLabel = computed(() => selected.value?.label ?? props.placeholder ?? "");

function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) {
    activeIndex.value = props.options.findIndex(
      (o) => String(o.value) === String(props.modelValue),
    );
  }
}

function pick(opt: Option) {
  if (opt.disabled) return;
  emit("update:modelValue", opt.value);
  open.value = false;
}

function onDocPointer(e: PointerEvent) {
  if (!open.value) return;
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}

function onKey(e: KeyboardEvent) {
  if (props.disabled) return;
  if (!open.value) {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      toggle();
    }
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    open.value = false;
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    activeIndex.value = nextEnabled(activeIndex.value, 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIndex.value = nextEnabled(activeIndex.value, -1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const opt = props.options[activeIndex.value];
    if (opt) pick(opt);
  }
}

function nextEnabled(from: number, dir: 1 | -1): number {
  const n = props.options.length;
  if (n === 0) return -1;
  let i = from;
  for (let step = 0; step < n; step++) {
    i = (i + dir + n) % n;
    if (!props.options[i].disabled) return i;
  }
  return from;
}

watch(open, (v) => {
  if (v) document.addEventListener("pointerdown", onDocPointer, true);
  else document.removeEventListener("pointerdown", onDocPointer, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointer, true);
});
</script>

<template>
  <div ref="root" class="relative flex-1" @keydown="onKey">
    <button
      :id="id"
      type="button"
      :disabled="disabled"
      :aria-haspopup="'listbox'"
      :aria-expanded="open"
      class="w-full flex items-center justify-between bg-surface-1 border border-border text-fg rounded-md focus:outline-none focus:border-border-strong disabled:opacity-50 cursor-pointer"
      :class="[
        size === 'sm' ? 'gap-1 px-1.5 py-0.5 text-xs' : 'gap-2 px-2 py-1.5 text-sm',
        { 'border-border-strong': open },
      ]"
      @click="toggle"
    >
      <span :class="selected ? '' : 'text-fg-subtle'" class="truncate">
        {{ buttonLabel }}
      </span>
      <ChevronDown
        :size="size === 'sm' ? 12 : 14"
        class="chevron shrink-0 text-fg-muted"
        :class="{ 'is-open': open }"
      />
    </button>
    <Transition name="dropdown-panel">
      <ul
        v-if="open"
        role="listbox"
        class="dropdown-panel absolute left-0 right-0 top-[calc(100%+4px)] z-50 max-h-60 overflow-y-auto bg-surface-1 border border-border-strong rounded-lg p-1 shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
      >
        <li
          v-for="(opt, i) in options"
          :key="String(opt.value)"
          role="option"
          :aria-selected="String(opt.value) === String(modelValue)"
          :aria-disabled="opt.disabled || undefined"
          class="dropdown-option cursor-pointer rounded-md flex items-center gap-1.5"
          :style="{ '--i': i }"
          :class="[
            size === 'sm' ? 'pl-1 pr-2 py-1 text-xs' : 'pl-1.5 pr-2.5 py-1.5 text-sm',
            opt.disabled
              ? 'text-fg-subtle cursor-default'
              : i === activeIndex
                ? 'bg-surface-2 text-fg'
                : 'text-fg hover:bg-surface-2',
            String(opt.value) === String(modelValue) && !opt.disabled
              ? 'text-accent'
              : '',
          ]"
          @mouseenter="activeIndex = i"
          @click="pick(opt)"
        >
          <span class="w-3.5 shrink-0 flex items-center justify-center">
            <Asterisk
              v-if="String(opt.value) === String(modelValue) && !opt.disabled"
              :size="11"
              :stroke-width="3"
            />
          </span>
          <span class="truncate">{{ opt.label }}</span>
        </li>
      </ul>
    </Transition>
  </div>
</template>

<style scoped>
/* Chevron rotation: bounces past 180° slightly for a playful settle. */
.chevron {
  transition: transform 220ms cubic-bezier(0.34, 1.5, 0.6, 1);
}
.chevron.is-open {
  transform: rotate(180deg);
}

/* Panel: subtle scale + slide + fade. Origin at top so it grows out of the
   button rather than from its own center. */
.dropdown-panel {
  transform-origin: top center;
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

/* Options cascade in with a small per-index delay. */
.dropdown-option {
  opacity: 0;
  transform: translateY(-4px);
  animation: dropdown-opt-in 220ms cubic-bezier(0.25, 0.9, 0.3, 1) forwards;
  animation-delay: calc(var(--i, 0) * 22ms);
  transition: transform 180ms cubic-bezier(0.34, 1.5, 0.6, 1);
}
.dropdown-option:not([aria-disabled="true"]):hover {
  transform: scale(1.02);
}
@keyframes dropdown-opt-in {
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .chevron,
  .dropdown-panel-enter-active,
  .dropdown-panel-leave-active,
  .dropdown-option {
    transition: none;
    animation: none !important;
    transform: none !important;
    opacity: 1 !important;
  }
}
</style>
