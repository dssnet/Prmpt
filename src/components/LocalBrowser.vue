<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  HardDrive,
  Link2,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  X,
} from "lucide-vue-next";

import {
  listLocalDir,
  localDrives,
  localHomeDir,
  localMkdir,
  localOpen,
  localRemove,
  localRename,
  localReveal,
  sftpDownload,
  writeInput,
  type LocalEntry,
} from "../ipc";
import { popupMenu } from "../contextMenu";
import {
  deliverSftpDrop,
  registerSftpTarget,
  sftpDropHint,
  startFileDrag,
  unregisterSftpTarget,
  type FileDropTarget,
  type SftpDragItem,
} from "../state/sftp";
import {
  dismissTransfer,
  markTransferError,
  trackTransfer,
  transfers,
} from "../state/transfers";
import { showHiddenFiles, toggleHiddenFiles } from "../state/uiPrefs";
import { ConfirmDialog } from "./ui";

const props = withDefaults(
  defineProps<{
    /** Terminal tab to target for `cd` / insert-path (active tab or pane). */
    targetTabId: number;
    /** Picker entries (panel mode): "local" + "sftp:<id>" values, see FilesPanel. */
    sources?: { value: string; label: string }[];
    /** The picker entry this column currently shows. */
    sourceValue?: string;
    canClose?: boolean;
    /** Shown in the header instead of the generic title (docked mode). */
    fixedLabel?: string;
  }>(),
  { canClose: false, sources: () => [] },
);
const emit = defineEmits<{ "update:source": [value: string]; close: [] }>();

const IS_WIN =
  typeof navigator !== "undefined" && /Win/i.test(navigator.platform);

// Focus a freshly-mounted inline editor (rename / new-folder fields).
const vFocus = { mounted: (el: HTMLInputElement) => el.focus() };

const EDIT_INPUT_CLASS =
  "flex-1 min-w-0 bg-surface-1 border border-border text-fg rounded-md px-2 py-1 text-xs focus:outline-none focus:border-border-strong";

const cwd = ref<string>("");
const parent = ref<string | null>(null);
const entries = ref<LocalEntry[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

// ---- back/forward history ----
const backStack = ref<string[]>([]);
const forwardStack = ref<string[]>([]);
const canGoBack = computed(() => backStack.value.length > 0);
const canGoForward = computed(() => forwardStack.value.length > 0);

// Hide dot-prefixed (hidden) entries unless the shared toggle is on.
const visibleEntries = computed(() =>
  entries.value.filter((e) => showHiddenFiles.value || !e.name.startsWith(".")),
);

const renamingPath = ref<string | null>(null);
const renameValue = ref("");
const creatingFolder = ref(false);
const newFolderValue = ref("");
const pendingDelete = ref<LocalEntry | null>(null);

const sep = computed(() => (IS_WIN && cwd.value.includes("\\") ? "\\" : "/"));

const crumbs = computed(() => {
  const path = cwd.value;
  if (!path) return [] as { label: string; path: string }[];
  const parts = path.split(/[/\\]+/).filter(Boolean);
  const acc: { label: string; path: string }[] = [];
  if (IS_WIN && /^[A-Za-z]:/.test(path)) {
    // Windows: first segment is the drive (e.g. "C:"), kept as "C:\".
    let p = parts[0] + "\\";
    acc.push({ label: parts[0], path: p });
    for (let i = 1; i < parts.length; i++) {
      p = (p.endsWith("\\") ? p : p + "\\") + parts[i];
      acc.push({ label: parts[i], path: p });
    }
  } else {
    acc.push({ label: "/", path: "/" });
    let p = "";
    for (const part of parts) {
      p += "/" + part;
      acc.push({ label: part, path: p });
    }
  }
  return acc;
});

// ---- address bar (editable path) ----
const editingPath = ref(false);
const pathDraft = ref("");
function startEditPath(): void {
  pathDraft.value = cwd.value;
  editingPath.value = true;
}
function commitEditPath(): void {
  const p = pathDraft.value.trim();
  editingPath.value = false;
  if (p && p !== cwd.value) void visit(p);
}

// ---- drive / volume picker ----
async function openDriveMenu(): Promise<void> {
  // Fetch fresh each open — removable drives come and go.
  let list: Awaited<ReturnType<typeof localDrives>>;
  try {
    list = await localDrives();
  } catch (err) {
    error.value = describeError(err);
    return;
  }
  if (!list.length) return;
  void popupMenu(
    list.map((d) => ({ text: d.name, action: () => void visit(d.path) })),
  );
}

function joinLocal(dir: string, name: string): string {
  const s = sep.value;
  return dir.endsWith(s) ? dir + name : dir + s + name;
}
function parentOf(p: string): string {
  const t = p.replace(/[/\\]+$/, "");
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  return i > 0 ? t.slice(0, i) : t.slice(0, i + 1);
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
function fmtDate(mtime: number | null): string {
  if (mtime == null) return "";
  return new Date(mtime * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
function describeError(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}

async function load(path: string): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const listing = await listLocalDir(path);
    cwd.value = listing.path;
    parent.value = listing.parent;
    entries.value = listing.entries;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
}

async function init(): Promise<void> {
  backStack.value = [];
  forwardStack.value = [];
  try {
    await load(await localHomeDir());
  } catch (err) {
    error.value = describeError(err);
  }
}

/** User-initiated navigation: push history, clear forward stack. */
async function visit(path: string): Promise<void> {
  const prev = cwd.value;
  await load(path);
  if (prev && cwd.value !== prev) {
    backStack.value.push(prev);
    forwardStack.value = [];
  }
}
async function goBack(): Promise<void> {
  const target = backStack.value[backStack.value.length - 1];
  if (!target) return;
  const prev = cwd.value;
  await load(target);
  if (cwd.value === target) {
    backStack.value.pop();
    forwardStack.value.push(prev);
  }
}
async function goForward(): Promise<void> {
  const target = forwardStack.value[forwardStack.value.length - 1];
  if (!target) return;
  const prev = cwd.value;
  await load(target);
  if (cwd.value === target) {
    forwardStack.value.pop();
    backStack.value.push(prev);
  }
}
function navigate(e: LocalEntry): void {
  if (e.is_dir) void visit(e.path);
}
function goUp(): void {
  if (parent.value) void visit(parent.value);
}
function refresh(): void {
  if (cwd.value) void load(cwd.value);
}

// ---- terminal integration ----
function shellQuote(p: string): string {
  if (IS_WIN) return `"${p.replace(/"/g, '\\"')}"`;
  return `'${p.replace(/'/g, "'\\''")}'`;
}
function sendToTerminal(text: string): void {
  void writeInput(props.targetTabId, new TextEncoder().encode(text));
}
function cdInto(e: LocalEntry): void {
  sendToTerminal(`cd ${shellQuote(e.path)}\n`);
}
function insertPath(e: LocalEntry): void {
  sendToTerminal(shellQuote(e.path));
}

// ---- OS integration ----
async function openInOs(e: LocalEntry): Promise<void> {
  try {
    await localOpen(e.path);
  } catch (err) {
    error.value = describeError(err);
  }
}
async function reveal(e: LocalEntry): Promise<void> {
  try {
    await localReveal(e.path);
  } catch (err) {
    error.value = describeError(err);
  }
}

// ---- new folder ----
function startNewFolder(): void {
  creatingFolder.value = true;
  newFolderValue.value = "";
}
async function commitNewFolder(): Promise<void> {
  if (!creatingFolder.value) return;
  const name = newFolderValue.value.trim();
  creatingFolder.value = false;
  if (!name) return;
  try {
    await localMkdir(joinLocal(cwd.value, name));
    refresh();
  } catch (err) {
    error.value = describeError(err);
  }
}

// ---- rename ----
function startRename(e: LocalEntry): void {
  renamingPath.value = e.path;
  renameValue.value = e.name;
}
async function commitRename(e: LocalEntry): Promise<void> {
  if (renamingPath.value !== e.path) return;
  const name = renameValue.value.trim();
  renamingPath.value = null;
  if (!name || name === e.name) return;
  try {
    await localRename(e.path, joinLocal(parentOf(e.path), name));
    refresh();
  } catch (err) {
    error.value = describeError(err);
  }
}

// ---- delete ----
async function confirmDelete(): Promise<void> {
  const e = pendingDelete.value;
  pendingDelete.value = null;
  if (!e) return;
  try {
    await localRemove(e.path, e.is_dir);
    refresh();
  } catch (err) {
    error.value = describeError(err);
  }
}

// ---- drag & drop ----------------------------------------------------------
// Drag source: drop onto an SFTP column to upload, or onto a local folder /
// another local column to move on disk.
function onRowMouseDown(ev: MouseEvent, e: LocalEntry): void {
  if ((ev.target as HTMLElement).closest("[data-local-action], input")) return;
  const item: SftpDragItem = {
    source: "local",
    srcTabId: props.targetTabId,
    path: e.path,
    name: e.name,
    isDir: e.is_dir,
  };
  startFileDrag(item, ev, (t) => void onDrop(item, t));
}

async function onDrop(item: SftpDragItem, t: FileDropTarget): Promise<void> {
  if (t.kind === "local") {
    // Any local column is this same filesystem → move into the folder (ignore
    // drops into the file's own current/parent dir).
    if (t.dir === item.path || t.dir === parentOf(item.path)) return;
    try {
      await localRename(item.path, joinLocal(t.dir, item.name));
      refresh();
    } catch (err) {
      error.value = describeError(err);
    }
  } else {
    // SFTP column → hand to that column to upload + track.
    deliverSftpDrop(t, item);
  }
}

// Drop target: an SFTP-sourced item dropped on this column is downloaded from
// its connection into the destination dir (the source column handles its own
// same-connection moves, so only cross-browser drops are delivered here).
// Rows live in the global transfers store under the "local" key, shared by
// every local column — all of them show the same filesystem.
const myTransfers = computed(() => transfers.value.filter((t) => t.key === "local"));

async function downloadInto(d: SftpDragItem, dstDir: string): Promise<void> {
  if (d.source !== "sftp") return;
  const id = trackTransfer("local", props.targetTabId, d.name, "down");
  try {
    await sftpDownload(d.srcTabId, d.path, joinLocal(dstDir, d.name), id);
    refresh();
  } catch (err) {
    markTransferError(id, describeError(err));
  }
}

const dropHandler = (item: SftpDragItem, dstDir: string) =>
  void downloadInto(item, dstDir);
watch(
  () => props.targetTabId,
  (next, prev) => {
    if (prev != null) unregisterSftpTarget("local", prev, dropHandler);
    registerSftpTarget("local", next, dropHandler);
  },
  { immediate: true },
);

// ---- native menus ----
function openToolbarMenu(): void {
  void popupMenu([
    { text: "New folder", action: startNewFolder },
    null,
    {
      text: showHiddenFiles.value ? "Hide hidden files" : "Show hidden files",
      action: toggleHiddenFiles,
    },
  ]);
}
function openRowMenu(e: LocalEntry): void {
  void popupMenu([
    { text: "Open", action: () => void openInOs(e) },
    { text: "Reveal in file manager", action: () => void reveal(e) },
    null,
    ...(e.is_dir
      ? [{ text: "cd here in terminal", action: () => cdInto(e) }]
      : []),
    { text: "Insert path into terminal", action: () => insertPath(e) },
    null,
    { text: "Rename", action: () => startRename(e) },
    null,
    {
      text: "Delete",
      action: () => {
        pendingDelete.value = e;
      },
    },
  ]);
}

onMounted(() => void init());

onBeforeUnmount(() => {
  unregisterSftpTarget("local", props.targetTabId, dropHandler);
});
</script>

<template>
  <section class="flex flex-col h-full min-h-0 min-w-0 bg-surface-1 text-fg">
    <!-- header: nav actions, optional label, parent-injected actions, close -->
    <header class="flex items-center gap-1 px-2 h-8 border-b border-border shrink-0">
      <button type="button" class="icon-btn" title="Back" :disabled="!canGoBack" @click="goBack">
        <ArrowLeft :size="14" />
      </button>
      <button type="button" class="icon-btn" title="Forward" :disabled="!canGoForward" @click="goForward">
        <ArrowRight :size="14" />
      </button>
      <button type="button" class="icon-btn" title="Refresh" @click="refresh">
        <RefreshCw :size="14" :class="{ 'animate-spin': loading }" />
      </button>
      <button type="button" class="icon-btn" title="More actions" @click="openToolbarMenu">
        <MoreHorizontal :size="14" />
      </button>
      <span
        v-if="fixedLabel"
        class="flex-1 min-w-0 truncate text-xs font-semibold text-fg-subtle"
        :title="fixedLabel"
      >
        {{ fixedLabel }}
      </span>
      <select
        v-else-if="sources.length"
        :value="sourceValue"
        class="flex-1 min-w-0 bg-surface-1 border border-border text-fg rounded-md px-1.5 py-1 text-xs focus:outline-none focus:border-border-strong"
        title="Location"
        @change="emit('update:source', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="s in sources" :key="s.value" :value="s.value">
          {{ s.label }}
        </option>
      </select>
      <span v-else class="flex-1" />
      <button
        v-if="canClose"
        type="button"
        class="icon-btn"
        title="Hide file browser"
        @click="emit('close')"
      >
        <X :size="14" />
      </button>
    </header>

    <!-- breadcrumb / address bar -->
    <div class="flex items-center gap-1 px-2.5 py-1.5 border-b border-border text-xs text-fg-muted shrink-0">
      <button
        v-if="IS_WIN"
        type="button"
        class="icon-btn shrink-0"
        title="Drives"
        @click="openDriveMenu"
      >
        <HardDrive :size="13" />
      </button>

      <input
        v-if="editingPath"
        v-model="pathDraft"
        v-focus
        :class="EDIT_INPUT_CLASS"
        spellcheck="false"
        @keydown.enter="commitEditPath"
        @keydown.esc="editingPath = false"
        @blur="editingPath = false"
      />
      <template v-else>
        <div class="flex items-center flex-wrap gap-0.5 flex-1 min-w-0">
          <template v-for="(c, i) in crumbs" :key="c.path">
            <ChevronRight v-if="i > 0" :size="11" class="text-fg-subtle shrink-0" />
            <button
              type="button"
              class="px-1 py-0.5 rounded hover:bg-surface-2 truncate max-w-[140px]"
              :class="i === crumbs.length - 1 ? 'text-fg font-medium' : 'text-fg-muted'"
              @click="visit(c.path)"
            >
              {{ c.label }}
            </button>
          </template>
        </div>
        <button type="button" class="icon-btn shrink-0" title="Edit path" @click="startEditPath">
          <Pencil :size="13" />
        </button>
      </template>
    </div>

    <!-- listing (also a drop zone: SFTP items dropped here are downloaded) -->
    <div
      class="flex-1 min-h-0 overflow-y-auto pb-3"
      :class="{
        'ring-1 ring-inset ring-accent/50':
          sftpDropHint && sftpDropHint.kind === 'local' && sftpDropHint.tabId === targetTabId && sftpDropHint.dir === cwd,
      }"
      data-sftp-list
      data-sftp-kind="local"
      :data-sftp-tab="targetTabId"
      :data-sftp-cwd="cwd"
    >
      <div v-if="creatingFolder" class="flex items-center gap-2 px-2.5 py-1.5">
        <Folder :size="15" class="text-accent shrink-0" />
        <input
          v-model="newFolderValue"
          v-focus
          placeholder="New folder name"
          :class="EDIT_INPUT_CLASS"
          @keydown.enter="commitNewFolder"
          @keydown.esc="creatingFolder = false"
          @blur="commitNewFolder"
        />
      </div>

      <p
        v-if="!loading && visibleEntries.length === 0 && !creatingFolder"
        class="px-3 py-6 text-center text-xs text-fg-subtle"
      >
        Empty directory.
      </p>

      <ul class="py-0.5">
        <li
          v-if="parent"
          class="group flex items-center gap-2 px-2.5 py-1 text-xs cursor-default select-none hover:bg-surface-2"
          @click="goUp"
          @dblclick="goUp"
        >
          <Folder :size="15" class="shrink-0 text-accent" />
          <span class="flex-1 min-w-0 truncate text-fg">..</span>
        </li>
        <li
          v-for="e in visibleEntries"
          :key="e.path"
          class="group flex items-center gap-2 px-2.5 py-1 text-xs cursor-default select-none hover:bg-surface-2"
          :class="{
            'bg-accent/15 ring-1 ring-accent/40':
              e.is_dir && sftpDropHint && sftpDropHint.kind === 'local' && sftpDropHint.tabId === targetTabId && sftpDropHint.dir === e.path,
          }"
          data-sftp-kind="local"
          :data-sftp-tab="targetTabId"
          :data-sftp-folder="e.is_dir ? e.path : undefined"
          @mousedown="onRowMouseDown($event, e)"
          @dblclick="e.is_dir ? navigate(e) : openInOs(e)"
          @contextmenu.prevent.stop="openRowMenu(e)"
        >
          <Link2 v-if="e.is_symlink" :size="15" class="shrink-0 text-accent" />
          <Folder v-else-if="e.is_dir" :size="15" class="shrink-0 text-accent" />
          <FileIcon v-else :size="15" class="shrink-0 text-fg-subtle" />

          <template v-if="renamingPath === e.path">
            <input
              v-model="renameValue"
              v-focus
              :class="EDIT_INPUT_CLASS"
              @keydown.enter="commitRename(e)"
              @keydown.esc="renamingPath = null"
              @blur="commitRename(e)"
            />
          </template>
          <template v-else>
            <button
              type="button"
              class="flex-1 min-w-0 truncate text-left"
              :class="e.is_dir ? 'text-fg' : 'text-fg-muted'"
              @click="e.is_dir ? navigate(e) : insertPath(e)"
            >
              {{ e.name }}
            </button>
            <span class="shrink-0 w-16 text-right text-fg-subtle tabular-nums">
              {{ e.is_dir ? "" : fmtSize(e.size) }}
            </span>
            <span class="shrink-0 w-20 text-right text-fg-subtle hidden 2xl:inline">
              {{ fmtDate(e.mtime) }}
            </span>
            <span
              data-local-action
              class="shrink-0 opacity-0 group-hover:opacity-100"
            >
              <button type="button" class="icon-btn" title="Actions" @click.stop="openRowMenu(e)">
                <MoreHorizontal :size="13" />
              </button>
            </span>
          </template>
        </li>
      </ul>
    </div>

    <!-- transfers (downloads dropped onto a local column) -->
    <div v-if="myTransfers.length" class="border-t border-border px-2.5 py-1.5 shrink-0 flex flex-col gap-1.5 max-h-40 overflow-y-auto">
      <div v-for="t in myTransfers" :key="t.id" class="text-xs">
        <div class="flex items-center gap-1.5">
          <Download :size="11" class="text-fg-subtle shrink-0" />
          <span class="flex-1 min-w-0 truncate" :class="t.error ? 'text-danger' : 'text-fg-muted'">
            {{ t.name }}
          </span>
          <LoaderCircle v-if="!t.done" :size="11" class="animate-spin text-fg-subtle shrink-0" />
          <span v-if="t.error" class="text-danger shrink-0" :title="t.error">failed</span>
          <span v-else-if="t.done" class="text-accent shrink-0">done</span>
          <span v-else-if="t.total" class="text-fg-subtle shrink-0 tabular-nums">
            {{ Math.floor((t.transferred / t.total) * 100) }}%
          </span>
          <!-- Nothing counted yet: the backend is still scanning the tree /
               opening the first file, not stalled. -->
          <span v-else-if="t.transferred === 0" class="text-fg-subtle shrink-0">preparing…</span>
          <span v-else class="text-fg-subtle shrink-0 tabular-nums">{{ fmtSize(t.transferred) }}</span>
          <button type="button" class="icon-btn" title="Dismiss" @click="dismissTransfer(t.id)">
            <X :size="11" />
          </button>
        </div>
        <div v-if="t.error" class="text-danger truncate mt-0.5 pl-[19px]" :title="t.error">
          {{ t.error }}
        </div>
        <div v-if="!t.done && t.total" class="h-0.5 mt-1 rounded bg-surface-2 overflow-hidden">
          <div class="h-full bg-accent" :style="{ width: `${(t.transferred / t.total) * 100}%` }" />
        </div>
      </div>
    </div>

    <p v-if="error" class="px-2.5 py-1.5 text-xs text-danger border-t border-border shrink-0 truncate" :title="error">
      {{ error }}
    </p>

    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="pendingDelete?.is_dir ? 'Delete folder?' : 'Delete file?'"
      :message="`Permanently delete “${pendingDelete?.name}” from disk?`"
      confirm-label="Delete"
      cancel-label="Cancel"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </section>
</template>

<style scoped>
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--fg-subtle, #9399b2);
  cursor: pointer;
  flex: none;
}
.icon-btn:hover:not(:disabled) {
  color: var(--fg, #e6e6e6);
  background: color-mix(in srgb, var(--fg, #fff) 12%, transparent);
}
.icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
</style>
