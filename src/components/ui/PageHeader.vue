<script setup lang="ts">
defineProps<{
  title: string;
}>();
</script>

<template>
  <div class="flex items-center justify-between gap-3">
    <h2 class="m-0 text-base font-medium tracking-wide text-fg">{{ title }}</h2>
    <div v-if="$slots.actions" class="flex gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
