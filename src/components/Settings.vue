<script setup lang="ts">
import {
  Archive,
  ArrowLeft,
  Bell,
  Palette,
  RefreshCw,
  SquareTerminal,
} from "lucide-vue-next";
import { computed, ref, watch } from "vue";

import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";

import {
  BACKUP_ENCRYPTED_NEEDS_PASSPHRASE,
  exportBackup,
  getConfig,
  importBackup,
  setTerminalPrefs,
} from "../ipc";
import { applyTheme, useTheme } from "../state/theme";
import { findPresetMatch, PRESETS } from "../state/themes";
import { setToastsEnabled, toastsEnabled } from "../state/uiPrefs";
import { runUpdateCheck, useUpdate } from "../state/update";
import FontStackInput from "./FontStackInput.vue";
import { Button, ConfirmDialog, Input, Modal, Switch } from "./ui";

const emit = defineEmits<{ back: []; openCustom: [] }>();
const { theme } = useTheme();
const { status: updateStatus } = useUpdate();

// ---- Section navigation (left sidebar) ----
type Section = "appearance" | "terminal" | "notifications" | "updates" | "backup";
const section = ref<Section>("appearance");
const SECTIONS = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "updates", label: "Updates", icon: RefreshCw },
  { id: "backup", label: "Backup", icon: Archive },
] as const;

function navClass(id: Section): string {
  const base =
    "w-full flex items-center gap-1.5 px-1.5 py-1.5 rounded-md text-sm text-left cursor-pointer transition-colors duration-150";
  return section.value === id
    ? `${base} bg-surface-3 text-fg`
    : `${base} text-fg-muted hover:bg-surface-2 hover:text-fg`;
}

const activeName = computed(() => findPresetMatch(theme.value));

const version = ref<string>("");
void getVersion().then((v) => {
  version.value = v;
});

// ---- Terminal settings ----
// Mirrors config.toml's core fields. `shell` is edited as a string ("" =
// system default → null in the config).
interface TerminalForm {
  font_family: string;
  font_size: number;
  line_height: number;
  shell: string;
  login_shell: boolean;
  scrollback_lines: number;
}

const term = ref<TerminalForm | null>(null);
const termStatus = ref<{ tone: "ok" | "err"; text: string } | null>(null);

void getConfig().then((c) => {
  term.value = {
    font_family: c.font_family,
    font_size: c.font_size,
    line_height: c.line_height,
    shell: c.shell ?? "",
    login_shell: c.login_shell,
    scrollback_lines: c.scrollback_lines,
  };
});

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

async function saveTerminal() {
  const t = term.value;
  if (!t) return;
  if (!t.font_family.trim()) {
    termStatus.value = { tone: "err", text: "Add at least one font." };
    return;
  }
  termStatus.value = null;
  try {
    // Out-of-range values are clamped in what's written, but the form is
    // left as typed (writing back would re-trigger the autosave watcher).
    await setTerminalPrefs({
      font_family: t.font_family.trim(),
      font_size: clamp(t.font_size, 6, 72),
      line_height: clamp(t.line_height, 0.8, 3),
      shell: t.shell.trim() ? t.shell.trim() : null,
      login_shell: t.login_shell,
      scrollback_lines: Math.max(0, Math.round(t.scrollback_lines)),
    });
    termStatus.value = { tone: "ok", text: "Saved." };
  } catch (e) {
    termStatus.value = { tone: "err", text: `Save failed: ${errText(e)}` };
  }
}

// Autosave: any edit persists after a short pause. The initial population
// (old === null) must not save what was just loaded.
let termSaveTimer: number | undefined;
watch(
  term,
  (t, old) => {
    if (!t || old === null) return;
    window.clearTimeout(termSaveTimer);
    termSaveTimer = window.setTimeout(() => void saveTerminal(), 500);
  },
  { deep: true },
);

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
  <div class="absolute inset-0 flex text-fg">
    <!-- Sidebar: section tabs (floating card, like the home tab's group tree) -->
    <aside
      class="flex-none w-44 my-4 ml-4 flex flex-col border border-border rounded-lg bg-surface-1 overflow-hidden"
    >
      <div class="flex items-center gap-1 px-2 py-2 flex-none border-b border-border">
        <button
          type="button"
          title="Back to hosts"
          aria-label="Back"
          class="shrink-0 grid place-items-center w-6 h-6 rounded-md text-fg-muted hover:text-fg hover:bg-surface-2 cursor-pointer transition-colors duration-150"
          @click="emit('back')"
        >
          <ArrowLeft :size="15" />
        </button>
        <span class="flex-1 min-w-0 truncate px-0.5 text-sm font-medium">Settings</span>
      </div>
      <nav class="flex-1 min-h-0 overflow-y-auto px-2 py-2 flex flex-col gap-0.5">
        <button
          v-for="s in SECTIONS"
          :key="s.id"
          type="button"
          :class="navClass(s.id)"
          @click="section = s.id"
        >
          <component :is="s.icon" :size="14" class="shrink-0" />
          {{ s.label }}
        </button>
      </nav>
    </aside>

    <!-- content -->
    <div class="flex-1 min-w-0 overflow-y-auto px-8 py-5">
      <div class="max-w-150 flex flex-col gap-4">
        <!-- Appearance -->
        <template v-if="section === 'appearance'">
          <header>
            <h2 class="m-0 text-base font-medium tracking-wide">Appearance</h2>
            <p class="m-0 mt-1 text-xs text-fg-muted">
              Color theme for the terminal and interface.
            </p>
          </header>
          <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
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
        </template>

        <!-- Terminal -->
        <template v-else-if="section === 'terminal'">
          <header>
            <h2 class="m-0 text-base font-medium tracking-wide">Terminal</h2>
            <p class="m-0 mt-1 text-xs text-fg-muted">
              Changes save automatically. Shell and scrollback apply to newly
              opened tabs; font settings take effect after restarting Prmpt.
            </p>
          </header>
          <div v-if="term" class="flex flex-col">
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-title">Font family</div>
                <div class="setting-hint">
                  Tried in order — the first font wins, the rest fill in
                  missing glyphs.
                </div>
              </div>
              <FontStackInput v-model="term.font_family" class="w-72 shrink-0" />
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-title">Font size</div>
                <div class="setting-hint">In pixels.</div>
              </div>
              <Input v-model="term.font_size" type="number" :min="6" :max="72" class="w-24 shrink-0" />
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-title">Line height</div>
                <div class="setting-hint">Multiple of the font size, e.g. 1.2.</div>
              </div>
              <Input v-model="term.line_height" type="number" :min="0.8" :max="3" class="w-24 shrink-0" />
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-title">Shell</div>
                <div class="setting-hint">Program started in new tabs.</div>
              </div>
              <Input
                v-model="term.shell"
                class="w-72 shrink-0"
                :spellcheck="false"
                placeholder="System default"
              />
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-title">Login shell</div>
                <div class="setting-hint">Start the shell as a login shell (loads your profile).</div>
              </div>
              <Switch v-model="term.login_shell" />
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-title">Scrollback lines</div>
                <div class="setting-hint">History kept per tab.</div>
              </div>
              <Input v-model="term.scrollback_lines" type="number" :min="0" class="w-28 shrink-0" />
            </div>
          </div>
          <span
            v-if="termStatus"
            class="text-xs"
            :class="termStatus.tone === 'err' ? 'text-danger' : 'text-fg-subtle'"
          >
            {{ termStatus.text }}
          </span>
        </template>

        <!-- Notifications -->
        <template v-else-if="section === 'notifications'">
          <header>
            <h2 class="m-0 text-base font-medium tracking-wide">Notifications</h2>
          </header>
          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-title">Toast notifications</div>
              <div class="setting-hint">
                Pop up bottom-right when a file operation finishes on a
                background tab. Tab-bar bells and transfer rows are unaffected.
              </div>
            </div>
            <Switch
              :model-value="toastsEnabled"
              @update:model-value="setToastsEnabled"
            />
          </div>
        </template>

        <!-- Updates -->
        <template v-else-if="section === 'updates'">
          <header>
            <h2 class="m-0 text-base font-medium tracking-wide">Updates</h2>
            <p v-if="version" class="m-0 mt-1 text-xs text-fg-muted">
              Current version {{ version }}
            </p>
          </header>
          <div class="flex items-center gap-3">
            <Button
              variant="secondary"
              :disabled="updateStatus === 'checking' || updateStatus === 'downloading'"
              @click="runUpdateCheck(true)"
            >
              {{ updateStatus === "checking" ? "Checking…" : "Check for updates" }}
            </Button>
          </div>
        </template>

        <!-- Backup & Restore -->
        <template v-else-if="section === 'backup'">
          <header>
            <h2 class="m-0 text-base font-medium tracking-wide">Backup &amp; Restore</h2>
            <p class="m-0 mt-1 text-xs text-fg-muted leading-snug">
              Export bundles your settings, saved hosts, keys and groups into a
              single file. Importing <strong>erases all current data</strong>
              and replaces it with the backup, then restarts the app.
            </p>
          </header>
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
        </template>
      </div>
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

<style scoped>
/* One setting per row: title + hint on the left, control on the right. */
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 10px 0;
  border-bottom: 1px solid
    color-mix(in srgb, var(--border, rgba(255, 255, 255, 0.08)) 60%, transparent);
}
.setting-row:last-child {
  border-bottom: none;
}
.setting-info {
  min-width: 0;
}
.setting-title {
  font-size: 12px;
  color: var(--fg, #e6e6e6);
}
.setting-hint {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--fg-subtle, #9399b2);
}
</style>
