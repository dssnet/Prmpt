<script setup lang="ts">
defineProps<{
  htmlFor?: string;
}>();
</script>

<template>
  <label :for="htmlFor" class="text-fg-muted text-sm">
    <slot />
  </label>
</template>
