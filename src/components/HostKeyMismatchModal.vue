<script setup lang="ts">
import { ref } from "vue";

import { getHost, resetHostFingerprint } from "../db";
import { type SshHostKeyMismatch } from "../ipc";
import { connectHost } from "../state/connect";
import { Button, Modal } from "./ui";

const props = defineProps<{ payload: SshHostKeyMismatch }>();
const emit = defineEmits<{ close: [] }>();

const busy = ref(false);

async function onTrust() {
  busy.value = true;
  try {
    await resetHostFingerprint(props.payload.host_id);
    const h = await getHost(props.payload.host_id);
    emit("close");
    if (h) await connectHost(h);
  } catch (err) {
    console.error("trust+reconnect failed:", err);
    alert(`Reconnect failed: ${err}`);
    busy.value = false;
  }
}
</script>

<template>
  <Modal title="Host key changed">
    <p class="m-0 text-xs text-fg-muted leading-snug">
      The server's host key does not match the one stored for this host.
      This could indicate a man-in-the-middle attack — or that the server's
      key was legitimately rotated.
    </p>
    <dl class="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1 m-0 font-mono text-[11px]">
      <dt class="text-fg-muted">Algorithm</dt>
      <dd class="m-0 text-fg break-all">{{ payload.algorithm }}</dd>
      <dt class="text-fg-muted">Stored</dt>
      <dd class="m-0 text-fg break-all">{{ payload.stored_fp }}</dd>
      <dt class="text-fg-muted">Received</dt>
      <dd class="m-0 text-fg break-all">{{ payload.received_fp }}</dd>
    </dl>
    <div class="flex gap-2 justify-end mt-1.5">
      <Button variant="secondary" :disabled="busy" @click="emit('close')">
        Cancel
      </Button>
      <Button variant="danger" :disabled="busy" @click="onTrust">
        Trust new key &amp; reconnect
      </Button>
    </div>
  </Modal>
</template>
