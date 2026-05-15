<script setup lang="ts">
import { Asterisk } from "lucide-vue-next";

defineProps<{
  modelValue?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();
</script>

<template>
  <label
    class="inline-flex items-center gap-1.5 text-xs text-fg-muted select-none"
    :class="disabled ? 'opacity-50 cursor-default' : 'cursor-pointer'"
  >
    <input
      type="checkbox"
      class="peer sr-only"
      :checked="modelValue"
      :disabled="disabled"
      @change="
        emit('update:modelValue', ($event.target as HTMLInputElement).checked)
      "
    />
    <span
      class="check-box inline-flex items-center justify-center w-4 h-4 shrink-0 rounded transition-colors duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40"
      :class="
        modelValue
          ? 'bg-accent text-bg is-checked'
          : 'bg-surface-2 text-fg-muted'
      "
    >
      <Transition name="check">
        <Asterisk
          v-if="modelValue"
          :size="12"
          :stroke-width="3"
        />
      </Transition>
    </span>
    <slot />
  </label>
</template>

<style scoped>
.check-enter-active {
  transition:
    transform 220ms cubic-bezier(0.34, 1.7, 0.5, 1),
    opacity 120ms ease-out;
}
.check-leave-active {
  transition:
    transform 140ms ease-in,
    opacity 100ms ease-in;
}
.check-enter-from {
  transform: scale(0) rotate(-135deg);
  opacity: 0;
}
.check-leave-to {
  transform: scale(0) rotate(90deg);
  opacity: 0;
}

.check-box.is-checked {
  animation: check-pop 220ms cubic-bezier(0.34, 1.5, 0.6, 1);
}
@keyframes check-pop {
  0% {
    transform: scale(1);
  }
  45% {
    transform: scale(1.15);
  }
  100% {
    transform: scale(1);
  }
}
</style>
