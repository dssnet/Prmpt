<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";

import { type PassphrasePromptState } from "../state/passphrase-prompt";
import { Button, Checkbox, Input, Modal } from "./ui";

const props = defineProps<{ state: PassphrasePromptState }>();

const value = ref("");
const save = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);

onMounted(async () => {
  await nextTick();
  // The Input wrapper renders an <input> inside; focus that.
  const el = (inputEl.value as unknown as HTMLElement | null)?.querySelector?.(
    "input",
  );
  el?.focus();
});

function onSubmit() {
  if (!value.value) return;
  props.state.resolve({ value: value.value, save: save.value });
}

function onCancel() {
  props.state.resolve(null);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    onCancel();
  } else if (e.key === "Enter") {
    e.preventDefault();
    onSubmit();
  }
}
</script>

<template>
  <Modal :title="state.title">
    <p v-if="state.hint" class="m-0 text-xs text-fg-muted leading-snug">
      {{ state.hint }}
    </p>
    <form class="flex flex-col gap-2.5" @submit.prevent="onSubmit">
      <div ref="inputEl">
        <Input
          type="password"
          autocomplete="current-password"
          placeholder="Password"
          v-model="value"
          @keydown="onKeydown"
        />
      </div>
      <Checkbox v-if="state.savable" v-model="save">
        Save for future connections
      </Checkbox>
      <div class="flex gap-2 justify-end mt-1.5">
        <Button variant="secondary" @click="onCancel">Cancel</Button>
        <Button type="submit" :disabled="!value">Connect</Button>
      </div>
    </form>
  </Modal>
</template>
