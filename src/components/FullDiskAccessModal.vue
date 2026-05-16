<script setup lang="ts">
import { ref } from "vue";

import { openFullDiskAccessSettings } from "../ipc";
import { Button, Modal } from "./ui";

const emit = defineEmits<{ close: [] }>();

const busy = ref(false);

async function openSettings() {
  busy.value = true;
  try {
    await openFullDiskAccessSettings();
  } catch (err) {
    console.error("open FDA settings failed:", err);
  } finally {
    emit("close");
  }
}
</script>

<template>
  <Modal>
    <h2 class="m-0 text-base font-semibold text-fg">Enable Full Disk Access</h2>
    <p class="m-0 text-xs text-fg-muted leading-snug">
      macOS restricts which folders apps — and the command-line tools they
      launch — are allowed to read. For Prmpt to run tools like
      <code>code</code> and let everything you run in the terminal reach files
      in protected locations (Desktop, Documents, iCloud, …), grant it
      <strong>Full Disk Access</strong>.
    </p>
    <ol
      class="m-0 pl-4 text-xs text-fg-muted leading-relaxed list-decimal flex flex-col gap-0.5"
    >
      <li>Click <strong>Open System Settings</strong> below.</li>
      <li>
        Enable <strong>Prmpt</strong> in the list (use the
        <strong>+</strong> button to add it if it isn't listed).
      </li>
      <li>Relaunch Prmpt when macOS prompts you to.</li>
    </ol>
    <p class="m-0 text-[11px] text-fg-muted leading-snug">
      You only need to do this once. You can change it any time in System
      Settings → Privacy &amp; Security → Full Disk Access.
    </p>
    <div class="flex gap-2 justify-end mt-1.5">
      <Button variant="secondary" :disabled="busy" @click="emit('close')">
        Maybe later
      </Button>
      <Button variant="primary" :disabled="busy" @click="openSettings">
        Open System Settings
      </Button>
    </div>
  </Modal>
</template>
