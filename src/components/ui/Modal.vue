<script setup lang="ts">
defineProps<{
  title?: string;
}>();
</script>

<template>
  <!-- Teleport to body so the overlay always sits above everything, regardless
       of the stacking context of whatever rendered it (e.g. a docked file
       browser overlay or a side-by-side panel column). -->
  <Teleport to="body">
    <div
      class="fixed inset-0 z-100 flex items-center justify-center p-8 backdrop-blur-md"
      style="background: color-mix(in srgb, var(--bg) 75%, transparent)"
    >
      <div class="bg-surface-1 border border-border-strong rounded-xl p-6 max-w-140 w-full flex flex-col gap-3.5 shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
        <h2 v-if="title" class="m-0 text-base font-semibold text-danger">{{ title }}</h2>
        <slot />
      </div>
    </div>
  </Teleport>
</template>
