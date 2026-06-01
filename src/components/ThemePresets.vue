<script setup lang="ts">
import { Palette } from "lucide-vue-next";
import { computed, ref } from "vue";

import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";

import {
  BACKUP_ENCRYPTED_NEEDS_PASSPHRASE,
  exportBackup,
  importBackup,
} from "../ipc";
import { applyTheme, useTheme } from "../state/theme";
import { findPresetMatch, PRESETS } from "../state/themes";
import { runUpdateCheck, useUpdate } from "../state/update";
import { Button, ConfirmDialog, Input, Modal } from "./ui";

const emit = defineEmits<{ back: []; openCustom: [] }>();
const { theme } = useTheme();
const { status: updateStatus } = useUpdate();

const activeName = computed(() => findPresetMatch(theme.value));

const version = ref<string>("");
void getVersion().then((v) => {
  version.value = v;
});

async function pickPreset(idx: number) {
  await applyTheme(PRESETS[idx].theme);
}

const cardClass =
  "flex flex-col gap-2 p-3 rounded-lg bg-surface-1 border border-border text-fg-muted text-left cursor-pointer font-[inherit] hover:bg-surface-2 hover:border-border-strong active:translate-y-px transition-colors duration-150";

function classFor(active: boolean): string {
  return active
    ? `${cardClass} !border-accent shadow-[inset_0_0_0_1px_var(--color-accent)]`
    : cardClass;
}

// ---- Backup & Restore ----

const backupBusy = ref(false);
const backupStatus = ref<{ tone: "ok" | "err"; text: string } | null>(null);

// Export: optional passphrase. Blank = unencrypted (with a warning).
const showExportModal = ref(false);
const exportPass = ref("");

function openExport() {
  exportPass.value = "";
  backupStatus.value = null;
  showExportModal.value = true;
}

async function confirmExport() {
  const passphrase = exportPass.value;
  showExportModal.value = false;
  const today = new Date().toISOString().slice(0, 10);
  let path: string | null;
  try {
    path = await saveDialog({
      defaultPath: `prmpt-backup-${today}.prmpt`,
      filters: [{ name: "Prmpt backup", extensions: ["prmpt"] }],
    });
  } catch (e) {
    backupStatus.value = { tone: "err", text: `Export failed: ${errText(e)}` };
    return;
  }
  if (!path) return; // user cancelled the save dialog

  backupBusy.value = true;
  backupStatus.value = null;
  try {
    await exportBackup(path, passphrase || undefined);
    backupStatus.value = {
      tone: "ok",
      text: passphrase
        ? "Encrypted backup exported."
        : "Backup exported (unencrypted).",
    };
  } catch (e) {
    backupStatus.value = { tone: "err", text: `Export failed: ${errText(e)}` };
  } finally {
    backupBusy.value = false;
  }
}

// Import: destructive, replaces all data, then relaunches.
const pendingImportPath = ref<string | null>(null);
const showImportConfirm = ref(false);
const showImportPass = ref(false);
const importPass = ref("");
const importPassError = ref<string | null>(null);

async function openImport() {
  backupStatus.value = null;
  let path: string | string[] | null;
  try {
    path = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Prmpt backup", extensions: ["prmpt"] }],
    });
  } catch (e) {
    backupStatus.value = { tone: "err", text: `Import failed: ${errText(e)}` };
    return;
  }
  if (typeof path !== "string") return; // cancelled
  pendingImportPath.value = path;
  showImportConfirm.value = true;
}

function cancelImport() {
  showImportConfirm.value = false;
  showImportPass.value = false;
  pendingImportPath.value = null;
  importPass.value = "";
  importPassError.value = null;
}

// First attempt: no passphrase. If the file turns out to be encrypted the
// backend asks for one (sentinel error) and we surface the passphrase modal.
async function confirmImport() {
  showImportConfirm.value = false;
  await runImport(undefined);
}

async function submitImportPass() {
  if (!importPass.value) return;
  importPassError.value = null;
  await runImport(importPass.value);
}

async function runImport(passphrase: string | undefined) {
  const path = pendingImportPath.value;
  if (!path) return;
  backupBusy.value = true;
  try {
    await importBackup(path, passphrase);
    // Staged successfully — relaunch so the swap is applied before the DB
    // is reopened. The new process picks up the imported data on boot.
    backupStatus.value = { tone: "ok", text: "Imported. Restarting…" };
    await relaunch();
  } catch (e) {
    const msg = errText(e);
    if (msg.includes(BACKUP_ENCRYPTED_NEEDS_PASSPHRASE)) {
      // Encrypted backup, no/blank passphrase yet — prompt for one.
      showImportPass.value = true;
    } else if (showImportPass.value) {
      // We're already prompting; a failure here is almost always a bad
      // passphrase. Keep the modal open and show why.
      importPassError.value = msg;
    } else {
      cancelImport();
      backupStatus.value = { tone: "err", text: `Import failed: ${msg}` };
    }
  } finally {
    backupBusy.value = false;
  }
}

function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
</script>

<template>
  <div class="absolute inset-0 flex flex-col gap-4 px-9 pt-2 pb-6 overflow-y-auto text-fg">
    <Button variant="ghost" @click="emit('back')">← Back</Button>
    <h2 class="m-0 text-base font-medium tracking-wide text-fg">Theme</h2>
    <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
      <button
        v-for="(preset, i) in PRESETS"
        :key="preset.name"
        type="button"
        :class="classFor(activeName === preset.name)"
        @click="pickPreset(i)"
      >
        <div
          class="w-full h-14 rounded-md flex items-center justify-center font-mono text-[22px] font-medium"
          :style="{ background: preset.theme.background, color: preset.theme.foreground }"
        >
          Aa
        </div>
        <div class="flex gap-0.75">
          <span
            v-for="(c, j) in preset.theme.palette.slice(0, 8)"
            :key="j"
            class="flex-1 h-2.5 rounded-xs"
            :style="{ background: c }"
          />
        </div>
        <div class="text-xs text-fg">{{ preset.name }}</div>
      </button>
      <button
        type="button"
        :class="classFor(activeName === null)"
        @click="emit('openCustom')"
      >
        <div class="w-full h-14 rounded-md flex items-center justify-center bg-transparent text-fg border border-dashed border-border-strong">
          <Palette :size="28" :stroke-width="1.8" />
        </div>
        <div class="flex gap-0.75">
          <span
            v-for="(c, j) in theme.palette.slice(0, 8)"
            :key="j"
            class="flex-1 h-2.5 rounded-xs"
            :style="{ background: c }"
          />
        </div>
        <div class="text-xs text-fg">Custom</div>
      </button>
    </div>

    <h2 class="m-0 mt-2 text-base font-medium tracking-wide text-fg">Updates</h2>
    <div class="flex items-center gap-3">
      <Button
        variant="secondary"
        :disabled="updateStatus === 'checking' || updateStatus === 'downloading'"
        @click="runUpdateCheck(true)"
      >
        {{ updateStatus === "checking" ? "Checking…" : "Check for updates" }}
      </Button>
      <span v-if="version" class="text-xs text-fg-muted">
        Current version {{ version }}
      </span>
    </div>

    <h2 class="m-0 mt-2 text-base font-medium tracking-wide text-fg">
      Backup &amp; Restore
    </h2>
    <p class="m-0 -mt-2 text-xs text-fg-muted leading-snug max-w-140">
      Export bundles your settings, saved hosts, keys and groups into a single
      file. Importing <strong>erases all current data</strong> and replaces it
      with the backup, then restarts the app.
    </p>
    <div class="flex items-center gap-3">
      <Button :disabled="backupBusy" @click="openExport">Export backup…</Button>
      <Button variant="secondary" :disabled="backupBusy" @click="openImport">
        Import backup…
      </Button>
      <span
        v-if="backupStatus"
        class="text-xs"
        :class="backupStatus.tone === 'err' ? 'text-danger' : 'text-fg-muted'"
      >
        {{ backupStatus.text }}
      </span>
    </div>

    <!-- Export options: optional encryption passphrase. -->
  <Modal v-if="showExportModal" title="Export backup">
    <p class="m-0 text-xs text-fg-muted leading-snug">
      Set a passphrase to encrypt the backup. Leave it blank to export
      unencrypted — note that an unencrypted backup contains the key to all of
      your saved SSH credentials in the clear.
    </p>
    <form class="flex flex-col gap-2.5" @submit.prevent="confirmExport">
      <Input
        type="password"
        autocomplete="new-password"
        placeholder="Encryption passphrase (optional)"
        v-model="exportPass"
      />
      <div class="flex gap-2 justify-end mt-1.5">
        <Button variant="secondary" @click="showExportModal = false">
          Cancel
        </Button>
        <Button type="submit">
          {{ exportPass ? "Export encrypted" : "Export unencrypted" }}
        </Button>
      </div>
    </form>
  </Modal>

  <!-- Destructive confirmation before staging an import. -->
  <ConfirmDialog
    :open="showImportConfirm"
    title="Import backup?"
    message="This erases all current settings, hosts, keys and groups and replaces them with the contents of the backup. The app will restart to finish. This cannot be undone."
    confirm-label="Erase and import"
    cancel-label="Cancel"
    @confirm="confirmImport"
    @cancel="cancelImport"
  />

  <!-- Passphrase prompt for an encrypted backup. -->
  <Modal v-if="showImportPass" title="Backup is encrypted">
    <p class="m-0 text-xs text-fg-muted leading-snug">
      Enter the passphrase this backup was encrypted with.
    </p>
    <form class="flex flex-col gap-2.5" @submit.prevent="submitImportPass">
      <Input
        type="password"
        autocomplete="current-password"
        placeholder="Passphrase"
        v-model="importPass"
      />
      <p v-if="importPassError" class="m-0 text-xs text-danger">
        {{ importPassError }}
      </p>
      <div class="flex gap-2 justify-end mt-1.5">
        <Button variant="secondary" @click="cancelImport">Cancel</Button>
        <Button type="submit" :disabled="!importPass || backupBusy">
          Decrypt and import
        </Button>
      </div>
    </form>
  </Modal>
  </div>
</template>
