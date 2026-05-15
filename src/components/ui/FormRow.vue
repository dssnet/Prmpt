<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    label?: string;
    htmlFor?: string;
    stack?: boolean;
    show?: boolean;
  }>(),
  { show: true },
);

const containerClass = computed(() =>
  props.stack
    ? "flex flex-col items-stretch gap-1 text-sm"
    : "flex items-center gap-2.5 text-sm",
);

const labelClass = computed(() =>
  props.stack
    ? "text-fg-muted mb-1"
    : "flex-none basis-[140px] text-fg-muted",
);
</script>

<template>
  <div v-show="show" :class="containerClass">
    <label v-if="label" :for="htmlFor" :class="labelClass">{{ label }}</label>
    <slot />
  </div>
</template>
