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
const listEl = ref<HTMLElement | null>(null);
const open = ref(false);
const activeIndex = ref(-1);
// Viewport rect for the teleported list, measured from the button on open
// (see the Teleport comment in the template).
const panelRect = ref({ left: 0, top: 0, width: 0 });

const selected = computed(() =>
  props.options.find((o) => String(o.value) === String(props.modelValue)),
);
const buttonLabel = computed(() => selected.value?.label ?? props.placeholder ?? "");

function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
  if (open.value) {
    const r = root.value?.getBoundingClientRect();
    if (r) panelRect.value = { left: r.left, top: r.bottom + 4, width: r.width };
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
  const t = e.target as Node;
  // The list lives under <body> (Teleport), not under `root` — check both.
  if (root.value?.contains(t) || listEl.value?.contains(t)) return;
  open.value = false;
}

// The list is anchored to a one-shot measurement of the button; if anything
// outside it scrolls (the panel, a settings page, …) or the window resizes,
// the anchor moves — close rather than drift. Scrolling *inside* the list
// (it has its own max-height) is fine.
function onAnyScroll(e: Event) {
  if (
    listEl.value &&
    e.target instanceof Node &&
    listEl.value.contains(e.target)
  ) {
    return;
  }
  open.value = false;
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
  if (v) {
    document.addEventListener("pointerdown", onDocPointer, true);
    window.addEventListener("scroll", onAnyScroll, true);
    window.addEventListener("resize", onAnyScroll);
  } else {
    document.removeEventListener("pointerdown", onDocPointer, true);
    window.removeEventListener("scroll", onAnyScroll, true);
    window.removeEventListener("resize", onAnyScroll);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointer, true);
  window.removeEventListener("scroll", onAnyScroll, true);
  window.removeEventListener("resize", onAnyScroll);
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
    <!-- Teleported + position:fixed: the list can't be clipped by ancestor
         `overflow` and can't be out-stacked by sticky headers inside scroll
         containers (WKWebView composites those above sibling content
         regardless of z-index). Anchored to the button rect measured on
         open; outside scroll / resize closes it instead of letting it
         drift (see onAnyScroll). -->
    <Teleport to="body">
      <Transition name="pop">
        <ul
          v-if="open"
          ref="listEl"
          role="listbox"
          :style="{
            left: `${panelRect.left}px`,
            top: `${panelRect.top}px`,
            width: `${panelRect.width}px`,
          }"
          class="pop-panel origin-top fixed z-50 max-h-60 overflow-y-auto p-1"
        >
        <li
          v-for="(opt, i) in options"
          :key="String(opt.value)"
          role="option"
          :aria-selected="String(opt.value) === String(modelValue)"
          :aria-disabled="opt.disabled || undefined"
          class="dropdown-option pop-item cursor-pointer rounded-md flex items-center gap-1.5"
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
    </Teleport>
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

/* Panel look/motion and the option cascade come from the shared `.pop-panel`
   / `pop` / `.pop-item` recipe in styles.css. */
.dropdown-option {
  transition: transform 180ms cubic-bezier(0.34, 1.5, 0.6, 1);
}
.dropdown-option:not([aria-disabled="true"]):hover {
  transform: scale(1.02);
}

@media (prefers-reduced-motion: reduce) {
  .chevron,
  .dropdown-option {
    transition: none;
    transform: none !important;
  }
}
</style>
