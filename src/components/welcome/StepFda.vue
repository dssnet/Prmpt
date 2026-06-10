<script setup lang="ts">
import { Check } from "lucide-vue-next";
import { onBeforeUnmount, onMounted, ref } from "vue";

import { fullDiskAccessGranted, openFullDiskAccessSettings } from "../../ipc";
import { Button } from "../ui";

const emit = defineEmits<{ done: [] }>();

const granted = ref(false);
const busy = ref(false);

let pollTimer: ReturnType<typeof setInterval> | undefined;
let advanceTimer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;

function stopPolling(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

async function pollOnce(): Promise<void> {
  if (inFlight || granted.value) return;
  inFlight = true;
  try {
    if (await fullDiskAccessGranted()) {
      stopPolling();
      granted.value = true;
      // Brief "Access granted" beat before moving on.
      advanceTimer = setTimeout(() => emit("done"), 1200);
    }
  } catch (err) {
    console.error("Full Disk Access check failed:", err);
  } finally {
    inFlight = false;
  }
}

async function openSettings(): Promise<void> {
  busy.value = true;
  try {
    await openFullDiskAccessSettings();
  } catch (err) {
    console.error("open FDA settings failed:", err);
  } finally {
    busy.value = false;
  }
}

function skip(): void {
  stopPolling();
  if (advanceTimer !== undefined) clearTimeout(advanceTimer);
  emit("done");
}

onMounted(() => {
  // Poll from step entry, not just after the button — the user may grant
  // access via a System Settings window they opened themselves.
  //
  // macOS quirk: toggling FDA can prompt the user to relaunch the app. If
  // they accept, the welcome flag isn't set yet so the welcome shows again
  // on restart — self-correcting, since FDA is then granted and this step
  // is skipped entirely.
  pollTimer = setInterval(() => void pollOnce(), 2000);
});

onBeforeUnmount(() => {
  stopPolling();
  if (advanceTimer !== undefined) clearTimeout(advanceTimer);
});
</script>

<template>
  <div class="flex flex-col gap-4 max-w-xl px-8 text-left">
    <h2 class="m-0 text-2xl font-semibold text-fg">Enable Full Disk Access</h2>
    <p class="m-0 text-sm text-fg-muted leading-relaxed">
      macOS restricts which folders apps — and the command-line tools they
      launch — are allowed to read. For Prmpt to run tools like
      <code>code</code> and let everything you run in the terminal reach files
      in protected locations (Desktop, Documents, iCloud, …), grant it
      <strong>Full Disk Access</strong>.
    </p>
    <ol
      class="m-0 pl-4 text-sm text-fg-muted leading-relaxed list-decimal flex flex-col gap-1"
    >
      <li>Click <strong>Open System Settings</strong> below.</li>
      <li>
        Enable <strong>Prmpt</strong> in the list (use the
        <strong>+</strong> button to add it if it isn't listed).
      </li>
      <li>Relaunch Prmpt when macOS prompts you to.</li>
    </ol>
    <p class="m-0 text-xs text-fg-muted leading-snug">
      You only need to do this once. You can change it any time in System
      Settings → Privacy &amp; Security → Full Disk Access.
    </p>
    <div v-if="granted" class="flex items-center gap-2 mt-2 text-accent">
      <Check :size="18" />
      <span class="text-sm font-medium">Access granted</span>
    </div>
    <div v-else class="flex gap-2 mt-2">
      <Button variant="primary" :disabled="busy" @click="openSettings">
        Open System Settings
      </Button>
      <Button variant="secondary" @click="skip">Skip for now</Button>
    </div>
  </div>
</template>
