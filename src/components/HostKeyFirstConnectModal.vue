<script setup lang="ts">
import { onMounted, ref } from "vue";

import { getHost, recordHostFingerprint } from "../db";
import { sshConfirmHostKey, type SshHostKeyFirstConnect } from "../ipc";
import { Button, Modal } from "./ui";

const props = defineProps<{ payload: SshHostKeyFirstConnect }>();
const emit = defineEmits<{ close: [] }>();

const busy = ref(false);
const hostLabel = ref("");

onMounted(async () => {
  try {
    const h = await getHost(props.payload.host_id);
    if (h) hostLabel.value = `${h.username}@${h.hostname}:${h.port}`;
  } catch {
    /* label is cosmetic; the fingerprint is what matters */
  }
});

async function onAccept() {
  busy.value = true;
  try {
    await recordHostFingerprint(
      props.payload.host_id,
      props.payload.fingerprint,
      props.payload.algorithm,
    );
    await sshConfirmHostKey(props.payload.tab_id, true);
  } catch (err) {
    console.error("host key accept failed:", err);
  }
  emit("close");
}

async function onReject() {
  busy.value = true;
  try {
    await sshConfirmHostKey(props.payload.tab_id, false);
  } catch (err) {
    console.error("host key reject failed:", err);
  }
  emit("close");
}
</script>

<template>
  <Modal title="Verify host key">
    <p class="m-0 text-xs text-fg-muted leading-snug">
      This host hasn't been seen before. Verify the fingerprint matches the
      one the server's administrator published before connecting — accepting
      a forged key would hand the connection (and your credentials) to an
      attacker.
    </p>
    <dl class="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1 m-0 font-mono text-[11px]">
      <template v-if="hostLabel">
        <dt class="text-fg-muted">Host</dt>
        <dd class="m-0 text-fg break-all">{{ hostLabel }}</dd>
      </template>
      <dt class="text-fg-muted">Algorithm</dt>
      <dd class="m-0 text-fg break-all">{{ payload.algorithm }}</dd>
      <dt class="text-fg-muted">Fingerprint</dt>
      <dd class="m-0 text-fg break-all">{{ payload.fingerprint }}</dd>
    </dl>
    <div class="flex gap-2 justify-end mt-1.5">
      <Button variant="secondary" :disabled="busy" @click="onReject">
        Cancel
      </Button>
      <Button variant="primary" :disabled="busy" @click="onAccept">
        Trust this key &amp; connect
      </Button>
    </div>
  </Modal>
</template>
