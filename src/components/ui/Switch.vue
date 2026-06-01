<script setup lang="ts">
defineProps<{
  modelValue?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();
</script>

<template>
  <label
    class="relative inline-flex items-center shrink-0 select-none"
    :class="disabled ? 'opacity-50 cursor-default' : 'cursor-pointer'"
  >
    <input
      type="checkbox"
      class="peer sr-only"
      :checked="modelValue"
      :disabled="disabled"
      @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <span
      class="track w-9 h-5 rounded-full border transition-colors duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40"
      :class="
        modelValue
          ? 'border-accent bg-[color-mix(in_srgb,var(--accent)_35%,transparent)]'
          : 'border-border bg-surface-2'
      "
    />
    <span
      class="knob absolute top-[3px] left-[3px] w-3.5 h-3.5 rounded-full transition-transform duration-150"
      :class="modelValue ? 'translate-x-4 bg-accent' : 'translate-x-0 bg-fg-subtle'"
    />
  </label>
</template>

<style scoped>
@media (prefers-reduced-motion: reduce) {
  .track,
  .knob {
    transition: none;
  }
}
</style>
