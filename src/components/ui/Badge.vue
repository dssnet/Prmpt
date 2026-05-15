<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    tone?: "default" | "danger";
  }>(),
  { tone: "default" },
);

const className = computed(() =>
  props.tone === "danger"
    ? "inline-block text-[11px] rounded-full px-2 py-px w-fit mt-1 ml-1.5 border border-danger text-danger bg-[color-mix(in_srgb,var(--color-danger)_14%,transparent)]"
    : "inline-block text-[11px] rounded-full px-2 py-px w-fit mt-1 border border-border text-fg-muted bg-surface-2",
);
</script>

<template>
  <span :class="className">
    <slot />
  </span>
</template>
