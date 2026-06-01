<script setup lang="ts">
import Button from "./Button.vue";
import Modal from "./Modal.vue";

withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: "default" | "danger";
  }>(),
  { confirmLabel: "Continue", cancelLabel: "Cancel", tone: "danger" },
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <Modal v-if="open" :title="title">
    <p v-if="message" class="m-0 text-sm text-fg-muted leading-relaxed whitespace-pre-line">
      {{ message }}
    </p>
    <slot />
    <div class="flex justify-end gap-2 mt-1">
      <Button variant="secondary" @click="emit('cancel')">{{ cancelLabel }}</Button>
      <Button :variant="tone === 'danger' ? 'danger' : 'primary'" @click="emit('confirm')">
        {{ confirmLabel }}
      </Button>
    </div>
  </Modal>
</template>
