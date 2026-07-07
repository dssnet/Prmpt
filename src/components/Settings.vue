<script setup lang="ts">
import {
  Archive,
  ArrowLeft,
  Bell,
  Cloud,
  FolderOpen,
  Keyboard,
  Palette,
  RefreshCw,
  RotateCcw,
  SquareTerminal,
} from "lucide-vue-next";
import { computed, onBeforeUnmount, ref, watch } from "vue";

import { getVersion } from "@tauri-apps/api/app";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

import { errText, useBackupImport } from "../composables/useBackupImport";
import { isModifierKey } from "../input";
import { defaultTerminalConfig, exportBackup, getConfig, setTerminalPrefs } from "../ipc";
import {
  ACTIONS,
  actionTokens,
  chordFromEvent,
  conflictFor,
  isBindableChord,
  isCustomized,
  KEYBIND_SECTIONS,
  resetBinding,
  setBinding,
  type ActionMeta,
} from "../state/keybindings";
import { applyTheme, useTheme } from "../state/theme";
import { findPresetMatch, PRESETS } from "../state/themes";
import {
  autoOpenUpdateDialog,
  confirmCloseRunning,
  notificationSounds,
  notificationSoundsBackgroundOnly,
  setAutoOpenUpdateDialog,
  setConfirmCloseRunning,
  setNotificationSounds,
  setNotificationSoundsBackgroundOnly,
  setShowChangedDate,
  setShowCreatedDate,
  setShowHiddenFiles,
  setShowSize,
  setStartupView,
  setToastsEnabled,
  showChangedDate,
  showCreatedDate,
  showHiddenFiles,
  showSize,
  startupView,
  toastsEnabled,
} from "../state/uiPrefs";
import type { StartupView } from "../ipc";
import {
  lastSyncAt,
  lastSyncError,
  loadSyncSettings,
  saveSyncSettings,
  syncBusy,
  syncEnabled,
  syncNow,
  testSyncConnection,
  type SyncSettingsForm,
} from "../state/sync";
import { runUpdateCheck, useUpdate } from "../state/update";
import FontStackInput from "./FontStackInput.vue";
import { Button, ConfirmDialog, Input, Modal, Switch } from "./ui";

const emit = defineEmits<{ back: []; openCustom: [] }>();
const { theme } = useTheme();
const { status: updateStatus } = useUpdate();

// ---- Section navigation (left sidebar) ----
type Section =
  | "appearance"
  | "terminal"
  | "shortcuts"
  | "filebrowser"
  | "notifications"
  | "sync"
  | "updates"
  | "backup";
const section = ref<Section>("appearance");
const SECTIONS = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "filebrowser", label: "File Browser", icon: FolderOpen },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "sync", label: "Sync", icon: Cloud },
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

// Resets everything shown in this tab, including the confirm-close switch
// (a ui pref). Persistence of the terminal fields rides the autosave watcher.
async function resetTerminal() {
  try {
    const d = await defaultTerminalConfig();
    term.value = {
      font_family: d.font_family,
      font_size: d.font_size,
      line_height: d.line_height,
      shell: d.shell ?? "",
      login_shell: d.login_shell,
      scrollback_lines: d.scrollback_lines,
    };
    setConfirmCloseRunning(d.ui.confirm_close_running);
    setStartupView(d.ui.startup_view);
    termStatus.value = { tone: "ok", text: "Reset to defaults." };
  } catch (e) {
    termStatus.value = { tone: "err", text: `Reset failed: ${errText(e)}` };
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

// ---- Keyboard shortcuts ----
// Actions grouped for display in the shipped section order.
const shortcutGroups = computed(() =>
  KEYBIND_SECTIONS.map((s) => ({
    section: s,
    actions: ACTIONS.filter((a) => a.section === s),
  })).filter((g) => g.actions.length > 0),
);

// id of the action currently capturing a new chord (null = idle), plus the
// last rejection reason shown beneath it.
const capturingId = ref<string | null>(null);
const captureError = ref<string | null>(null);

function startCapture(a: ActionMeta) {
  if (a.editable === false) return;
  if (capturingId.value === a.id) {
    stopCapture();
    return;
  }
  captureError.value = null;
  capturingId.value = a.id;
  window.addEventListener("keydown", onCaptureKey, true);
}

function stopCapture() {
  capturingId.value = null;
  captureError.value = null;
  window.removeEventListener("keydown", onCaptureKey, true);
}

function onCaptureKey(e: KeyboardEvent) {
  // Swallow everything while recording so the chord can't also fire an app
  // shortcut or reach the terminal underneath.
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") {
    stopCapture();
    return;
  }
  if (isModifierKey(e)) return; // wait for the non-modifier key in the chord
  const id = capturingId.value;
  if (!id) return;
  const chord = chordFromEvent(e);
  if (!isBindableChord(chord)) {
    captureError.value = "Add a modifier (⌘, ⌥…) — a bare key would clash with the terminal.";
    return;
  }
  const clash = conflictFor(id, chord);
  if (clash) {
    captureError.value = `Already used by “${clash.label}”.`;
    return;
  }
  setBinding(id, chord);
  stopCapture();
}

onBeforeUnmount(stopCapture);

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

// ---- Sync (WebDAV) ----

// Credentials are saved explicitly (no autosave — half-typed passwords
// must never hit the keychain or trigger a sync against a wrong server).
const sync = ref<SyncSettingsForm | null>(null);
const syncFormStatus = ref<{ tone: "ok" | "err"; text: string } | null>(null);
const syncTestBusy = ref(false);

void loadSyncSettings().then((s) => {
  sync.value = s;
});

async function saveSyncForm() {
  const s = sync.value;
  if (!s) return;
  syncFormStatus.value = null;
  try {
    // Runs the first sync before resolving when enabling.
    await saveSyncSettings({ ...s });
    if (!s.enabled) {
      syncFormStatus.value = { tone: "ok", text: "Saved. Sync is off." };
    } else if (lastSyncError.value) {
      syncFormStatus.value = {
        tone: "err",
        text: `Saved, but sync failed: ${lastSyncError.value}`,
      };
    } else {
      syncFormStatus.value = { tone: "ok", text: "Saved and synced." };
    }
  } catch (e) {
    syncFormStatus.value = { tone: "err", text: errText(e) };
  }
}

async function syncNowClicked() {
  syncFormStatus.value = null;
  await syncNow(); // never throws — the result lands in lastSyncError
  syncFormStatus.value = lastSyncError.value
    ? { tone: "err", text: `Sync failed: ${lastSyncError.value}` }
    : { tone: "ok", text: "Sync complete." };
}

async function testSyncForm() {
  const s = sync.value;
  if (!s) return;
  syncFormStatus.value = null;
  syncTestBusy.value = true;
  try {
    await testSyncConnection(s);
    syncFormStatus.value = { tone: "ok", text: "Connection OK — WebDAV folder is reachable." };
  } catch (e) {
    syncFormStatus.value = { tone: "err", text: errText(e) };
  } finally {
    syncTestBusy.value = false;
  }
}

const lastSyncText = computed(() => {
  if (lastSyncError.value) return `Last sync failed: ${lastSyncError.value}`;
  if (!lastSyncAt.value) return "Not synced yet.";
  const d = new Date(lastSyncAt.value);
  return Number.isNaN(d.getTime())
    ? "Not synced yet."
    : `Last synced ${d.toLocaleString()}.`;
});

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

// Import: destructive, replaces all data, then relaunches. The state
// machine lives in useBackupImport (shared with the first-boot welcome).
const {
  busy: importBusy,
  showConfirm: showImportConfirm,
  showPassPrompt: showImportPass,
  passphrase: importPass,
  passError: importPassError,
  pickFile,
  confirm: confirmImport,
  cancel: cancelImport,
  submitPassphrase: submitImportPass,
} = useBackupImport({
  beforeRelaunch: () => {
    backupStatus.value = { tone: "ok", text: "Imported. Restarting…" };
  },
  onError: (msg) => {
    backupStatus.value = { tone: "err", text: `Import failed: ${msg}` };
  },
});

function openImport() {
  backupStatus.value = null;
  void pickFile();
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
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-title">Confirm before closing</div>
                <div class="setting-hint">
                  Warn when closing a tab or window would kill a running
                  program — e.g. Claude Code mid-task — or drop an open SSH
                  connection.
                </div>
              </div>
              <Switch
                :model-value="confirmCloseRunning"
                @update:model-value="setConfirmCloseRunning"
              />
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-title">Open on startup</div>
                <div class="setting-hint">
                  Which view a new window opens to. With Home (hosts, keys and
                  groups), a terminal still starts in the background, so the
                  window is never empty.
                </div>
              </div>
              <select
                :value="startupView"
                class="w-40 shrink-0 bg-surface-1 border border-border text-fg rounded-md px-2 py-1.5 text-sm cursor-pointer focus:outline-none focus:border-border-strong"
                @change="setStartupView(($event.target as HTMLSelectElement).value as StartupView)"
              >
                <option value="terminal">New terminal</option>
                <option value="home">Home</option>
              </select>
            </div>
            <div class="mt-2">
              <Button variant="secondary" size="sm" @click="resetTerminal">
                Reset to defaults
              </Button>
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

        <!-- Keyboard Shortcuts -->
        <template v-else-if="section === 'shortcuts'">
          <header>
            <h2 class="m-0 text-base font-medium tracking-wide">Keyboard Shortcuts</h2>
            <p class="m-0 mt-1 text-xs text-fg-muted leading-snug">
              Click a shortcut to record a new one; press Esc to cancel. Copy,
              paste, select-all and the tab-number switches are fixed.
            </p>
          </header>
          <div
            v-for="g in shortcutGroups"
            :key="g.section"
            class="flex flex-col"
          >
            <h3 class="mt-2 mb-0.5 text-xs font-medium text-fg-muted tracking-wide">
              {{ g.section }}
            </h3>
            <div v-for="a in g.actions" :key="a.id" class="setting-row">
              <div class="setting-info">
                <div class="setting-title">{{ a.label }}</div>
                <div v-if="a.hint" class="setting-hint">{{ a.hint }}</div>
                <div
                  v-if="capturingId === a.id && captureError"
                  class="setting-hint text-danger"
                >
                  {{ captureError }}
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <!-- Recording this action -->
                <button
                  v-if="capturingId === a.id"
                  type="button"
                  class="rounded border border-accent bg-surface-2 px-2 py-1 text-[11px] leading-none text-accent cursor-pointer"
                  @click="stopCapture"
                >
                  Press keys… <span class="text-fg-subtle">Esc</span>
                </button>
                <!-- Editable: click to rebind -->
                <button
                  v-else-if="a.editable !== false"
                  type="button"
                  title="Click to rebind"
                  class="flex items-center gap-1 rounded px-1 py-0.5 cursor-pointer hover:bg-surface-2 transition-colors duration-150"
                  @click="startCapture(a)"
                >
                  <kbd
                    v-for="(t, ti) in actionTokens(a)"
                    :key="ti"
                    class="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] leading-none text-fg-subtle"
                  >{{ t }}</kbd>
                </button>
                <!-- Fixed: display only -->
                <span v-else class="flex items-center gap-1 opacity-60">
                  <kbd
                    v-for="(t, ti) in actionTokens(a)"
                    :key="ti"
                    class="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] leading-none text-fg-subtle"
                  >{{ t }}</kbd>
                </span>
                <!-- Reset to default -->
                <button
                  v-if="a.editable !== false && isCustomized(a.id)"
                  type="button"
                  title="Reset to default"
                  class="shrink-0 grid place-items-center w-6 h-6 rounded-md text-fg-muted hover:text-fg hover:bg-surface-2 cursor-pointer transition-colors duration-150"
                  @click="resetBinding(a.id)"
                >
                  <RotateCcw :size="13" />
                </button>
                <span v-else class="w-6 h-6 shrink-0" />
              </div>
            </div>
          </div>
        </template>

        <!-- File Browser -->
        <template v-else-if="section === 'filebrowser'">
          <header>
            <h2 class="m-0 text-base font-medium tracking-wide">File Browser</h2>
            <p class="m-0 mt-1 text-xs text-fg-muted">
              What the local and SFTP file browsers show. Also available from
              the browsers' ⋯ menu.
            </p>
          </header>
          <div class="flex flex-col">
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-title">Show hidden files</div>
                <div class="setting-hint">
                  Show dot-prefixed entries. Shared by the local and SFTP
                  browsers.
                </div>
              </div>
              <Switch
                :model-value="showHiddenFiles"
                @update:model-value="setShowHiddenFiles"
              />
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-title">Size column</div>
                <div class="setting-hint">Show the file size column.</div>
              </div>
              <Switch :model-value="showSize" @update:model-value="setShowSize" />
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-title">Changed date column</div>
                <div class="setting-hint">Show the last-modified date column.</div>
              </div>
              <Switch
                :model-value="showChangedDate"
                @update:model-value="setShowChangedDate"
              />
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-title">Created date column</div>
                <div class="setting-hint">
                  Show the created date column. Local browser only — the SFTP
                  protocol doesn't report creation time.
                </div>
              </div>
              <Switch
                :model-value="showCreatedDate"
                @update:model-value="setShowCreatedDate"
              />
            </div>
          </div>
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
                background tab, or when a program in an unfocused terminal
                rings the bell / sends a notification. Tab-bar bells and
                transfer rows are unaffected.
              </div>
            </div>
            <Switch
              :model-value="toastsEnabled"
              @update:model-value="setToastsEnabled"
            />
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-title">Notification sounds</div>
              <div class="setting-hint">
                Play a chime when a program rings the terminal bell or sends a
                notification — e.g. Claude Code finishing a task — and when a
                file transfer completes.
              </div>
            </div>
            <Switch
              :model-value="notificationSounds"
              @update:model-value="setNotificationSounds"
            />
          </div>
          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-title">Only when in the background</div>
              <div class="setting-hint">
                Play notification sounds only while the Prmpt window is
                unfocused. Silences the chime for a task that finishes in the
                window you're already watching.
              </div>
            </div>
            <Switch
              :model-value="notificationSoundsBackgroundOnly"
              :disabled="!notificationSounds"
              @update:model-value="setNotificationSoundsBackgroundOnly"
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
          <div class="setting-row">
            <div class="setting-info">
              <div class="setting-title">Show update dialog automatically</div>
              <div class="setting-hint">
                Pop up the update dialog when Prmpt finds a new version on
                launch or during a background check. Turn this off to update on
                your own time — a green download icon appears in the tab bar
                instead, and clicking it opens the dialog. "Check for updates"
                above always opens it.
              </div>
            </div>
            <Switch
              :model-value="autoOpenUpdateDialog"
              @update:model-value="setAutoOpenUpdateDialog"
            />
          </div>
        </template>

        <!-- Sync -->
        <template v-else-if="section === 'sync'">
          <header>
            <h2 class="m-0 text-base font-medium tracking-wide">Sync</h2>
            <p class="m-0 mt-1 text-xs text-fg-muted leading-snug">
              Keep hosts, keys and groups in sync across devices through a
              WebDAV folder (Nextcloud, ownCloud, …). Point every device at
              the same folder with the same encryption passphrase and changes
              merge automatically. Everything is encrypted with the
              passphrase before upload — the server never sees your
              credentials.
            </p>
          </header>
          <div v-if="sync" class="flex flex-col">
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-title">Enable sync</div>
                <div class="setting-hint">
                  Syncs on launch, after changes, and periodically while the
                  app is in use.
                </div>
              </div>
              <Switch v-model="sync.enabled" />
            </div>
            <div class="setting-stack">
              <div class="setting-title">WebDAV folder URL</div>
              <div class="setting-hint">
                An existing folder on your WebDAV server, e.g.
                https://cloud.example.com/remote.php/dav/files/you/prmpt/
              </div>
              <Input
                v-model="sync.url"
                class="mt-1.5"
                :spellcheck="false"
                placeholder="https://…"
              />
            </div>
            <div class="setting-stack">
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <div class="setting-title">Username</div>
                  <Input v-model="sync.username" class="mt-1.5" :spellcheck="false" />
                </div>
                <div>
                  <div class="setting-title">Password</div>
                  <Input
                    v-model="sync.password"
                    type="password"
                    autocomplete="new-password"
                    class="mt-1.5"
                  />
                </div>
              </div>
              <div class="setting-hint mt-1.5">
                WebDAV account credentials (use an app password if your server
                offers them). Stored in this device's encrypted store.
              </div>
            </div>
            <div class="setting-stack">
              <div class="setting-title">Encryption passphrase</div>
              <div class="setting-hint">
                Encrypts the synced data end-to-end — SSH passwords and keys
                travel inside it. Must match on every device; it is never
                sent to the server.
              </div>
              <Input
                v-model="sync.passphrase"
                type="password"
                autocomplete="new-password"
                class="mt-1.5"
              />
            </div>
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-title">Sync interval</div>
                <div class="setting-hint">Minutes between background syncs.</div>
              </div>
              <div class="w-24 shrink-0">
                <Input v-model="sync.intervalMinutes" type="number" :min="1" />
              </div>
            </div>
            <div class="mt-2 flex items-center gap-3">
              <Button :disabled="syncTestBusy || syncBusy" @click="saveSyncForm">
                Save
              </Button>
              <Button
                variant="secondary"
                :disabled="syncTestBusy || !sync.url.trim()"
                @click="testSyncForm"
              >
                {{ syncTestBusy ? "Testing…" : "Test connection" }}
              </Button>
              <Button
                variant="secondary"
                :disabled="syncBusy || !syncEnabled"
                @click="syncNowClicked"
              >
                {{ syncBusy ? "Syncing…" : "Sync now" }}
              </Button>
            </div>
            <p
              v-if="syncFormStatus"
              class="m-0 mt-2 text-xs"
              :class="syncFormStatus.tone === 'err' ? 'text-danger' : 'text-fg-muted'"
            >
              {{ syncFormStatus.text }}
            </p>
            <p
              class="m-0 mt-2 text-xs"
              :class="lastSyncError ? 'text-danger' : 'text-fg-subtle'"
            >
              {{ lastSyncText }}
            </p>
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
            <Button :disabled="backupBusy || importBusy" @click="openExport">
              Export backup…
            </Button>
            <Button
              variant="secondary"
              :disabled="backupBusy || importBusy"
              @click="openImport"
            >
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
        <Button type="submit" :disabled="!importPass || importBusy">
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
/* Stacked variant: title + hint with a full-width control underneath —
   for inputs (URLs, credentials) too wide for the side-by-side row. */
.setting-stack {
  display: flex;
  flex-direction: column;
  padding: 10px 0;
  border-bottom: 1px solid
    color-mix(in srgb, var(--border, rgba(255, 255, 255, 0.08)) 60%, transparent);
}
.setting-stack:last-child {
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
