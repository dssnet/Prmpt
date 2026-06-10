<script setup lang="ts">
import { onMounted, ref } from "vue";

import { useBackupImport } from "../../composables/useBackupImport";
import { listHosts } from "../../db";
import { Button, ConfirmDialog, Input, Modal } from "../ui";

const emit = defineEmits<{ finish: [] }>();

// Upgraders may already have hosts/keys — their dismiss button must read
// "Continue" (current data is kept), not "Start fresh". Default to the
// safer "Continue" until the probe resolves.
const existing = ref(true);
const error = ref<string | null>(null);

onMounted(async () => {
  // Legacy flag = this install predates the welcome flow.
  if (localStorage.getItem("prmpt.fdaOnboardingSeen")) return;
  try {
    existing.value = (await listHosts()).length > 0;
  } catch {
    existing.value = false;
  }
});

const {
  busy,
  showConfirm,
  showPassPrompt,
  passphrase,
  passError,
  pickFile,
  confirm,
  cancel,
  submitPassphrase,
} = useBackupImport({
  // localStorage isn't part of the backup and the staged import is applied
  // at next start — set the flag now or the welcome reappears post-import.
  beforeRelaunch: () => {
    localStorage.setItem("prmpt.welcomeSeen", "1");
    localStorage.removeItem("prmpt.fdaOnboardingSeen");
  },
  onError: (msg) => {
    error.value = `Import failed: ${msg}`;
  },
});

function startImport(): void {
  error.value = null;
  void pickFile();
}
</script>

<template>
  <div class="flex flex-col gap-4 max-w-xl px-8 text-left">
    <h2 class="m-0 text-2xl font-semibold text-fg">Bring your data</h2>
    <p class="m-0 text-sm text-fg-muted leading-relaxed">
      Restore a <code>.prmpt</code> backup from another machine — settings,
      saved hosts, keys and groups —
      {{ existing ? "or continue with your current data." : "or start fresh." }}
    </p>
    <p v-if="error" class="m-0 text-xs text-danger">{{ error }}</p>
    <div class="flex gap-2 mt-2">
      <Button variant="primary" :disabled="busy" @click="startImport">
        Import a backup…
      </Button>
      <Button variant="secondary" :disabled="busy" @click="emit('finish')">
        {{ existing ? "Continue" : "Start fresh" }}
      </Button>
    </div>
  </div>

  <!-- Destructive confirmation before staging an import. -->
  <ConfirmDialog
    :open="showConfirm"
    title="Import backup?"
    message="This erases all current settings, hosts, keys and groups and replaces them with the contents of the backup. The app will restart to finish. This cannot be undone."
    confirm-label="Erase and import"
    cancel-label="Cancel"
    @confirm="confirm"
    @cancel="cancel"
  />

  <!-- Passphrase prompt for an encrypted backup. -->
  <Modal v-if="showPassPrompt" title="Backup is encrypted">
    <p class="m-0 text-xs text-fg-muted leading-snug">
      Enter the passphrase this backup was encrypted with.
    </p>
    <form class="flex flex-col gap-2.5" @submit.prevent="submitPassphrase">
      <Input
        type="password"
        autocomplete="current-password"
        placeholder="Passphrase"
        v-model="passphrase"
      />
      <p v-if="passError" class="m-0 text-xs text-danger">{{ passError }}</p>
      <div class="flex gap-2 justify-end mt-1.5">
        <Button variant="secondary" @click="cancel">Cancel</Button>
        <Button type="submit" :disabled="!passphrase || busy">
          Decrypt and import
        </Button>
      </div>
    </form>
  </Modal>
</template>
