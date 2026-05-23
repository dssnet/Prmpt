<script setup lang="ts">
import { computed } from "vue";

type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

const props = withDefaults(
  defineProps<{
    text?: string;
    placement?: Placement;
  }>(),
  { placement: "bottom-start" },
);

// Position the bubble against the corresponding edge of the trigger, and
// pre-translate it 2px toward that edge so group-hover can ease it home.
const placementClasses = computed<string>(() => {
  switch (props.placement) {
    case "bottom-end":
      return "top-full right-0 mt-1.5 -translate-y-0.5";
    case "top-start":
      return "bottom-full left-0 mb-1.5 translate-y-0.5";
    case "top-end":
      return "bottom-full right-0 mb-1.5 translate-y-0.5";
    case "bottom-start":
    default:
      return "top-full left-0 mt-1.5 -translate-y-0.5";
  }
});
</script>

<template>
  <span class="group relative inline-flex items-center">
    <slot />
    <span
      role="tooltip"
      class="absolute z-50 px-2 py-1 rounded-md whitespace-nowrap text-[11px] text-fg bg-surface-1 ring-1 ring-border-strong shadow-[0_4px_12px_rgba(0,0,0,0.35)] pointer-events-none opacity-0 transition-all duration-150 group-hover:opacity-100 group-hover:translate-y-0"
      :class="placementClasses"
    >
      <slot name="content">{{ text }}</slot>
    </span>
  </span>
</template>
