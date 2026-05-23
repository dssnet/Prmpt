<script setup lang="ts">
import { computed } from "vue";

import { type SshConnectError } from "../ipc";
import { Button, Modal } from "./ui";

const props = defineProps<{ payload: SshConnectError }>();
const emit = defineEmits<{ close: [] }>();

const title = computed(() => {
  switch (props.payload.kind) {
    case "auth":
      return "Authentication failed";
    case "connect":
      return "Could not reach host";
    case "channel":
      return "SSH session error";
    default:
      return "SSH connection failed";
  }
});

const lead = computed(() => {
  const { host_label, hostname, kind } = props.payload;
  switch (kind) {
    case "auth":
      return `${host_label} (${hostname}) rejected the credentials.`;
    case "connect":
      return `Could not connect to ${host_label} (${hostname}).`;
    case "channel":
      return `The session with ${host_label} (${hostname}) could not be opened.`;
    default:
      return `${host_label} (${hostname})`;
  }
});

const hint = computed(() => {
  switch (props.payload.kind) {
    case "auth":
      return "Edit the host to update the password or key, or try again to re-enter at the prompt.";
    case "connect":
      return "Check the hostname / port and your network, then try connecting again.";
    default:
      return null;
  }
});
</script>

<template>
  <Modal :title="title">
    <p class="m-0 text-xs text-fg-muted leading-snug">{{ lead }}</p>
    <pre
      class="m-0 px-2.5 py-2 rounded-md bg-surface-2 border border-border text-[11px] text-fg font-mono whitespace-pre-wrap break-words max-h-50 overflow-auto"
    >{{ payload.message }}</pre>
    <p v-if="hint" class="m-0 text-xs text-fg-subtle leading-snug">{{ hint }}</p>
    <div class="flex gap-2 justify-end mt-1.5">
      <Button @click="emit('close')">Close</Button>
    </div>
  </Modal>
</template>
