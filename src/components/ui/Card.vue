<script setup lang="ts">
withDefaults(
  defineProps<{
    as?: string;
  }>(),
  { as: "div" },
);
</script>

<template>
  <component
    :is="as"
    class="px-3.5 py-3 border border-border rounded-lg bg-surface-1 hover:border-border-strong transition-colors duration-150"
  >
    <slot />
  </component>
</template>
