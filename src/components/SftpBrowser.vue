<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  ArrowUp,
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  Link2,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-vue-next";

import {
  sftpDownload,
  sftpListDir,
  sftpMkdir,
  sftpRealpath,
  sftpRelay,
  sftpRemove,
  sftpRename,
  sftpUpload,
  onSftpAvailability,
  type SftpEntry,
} from "../ipc";
import {
  sftpDropHint,
  registerSftpTarget,
  unregisterSftpTarget,
  deliverSftpDrop,
  startFileDrag,
  type SftpDragItem,
  type FileDropTarget,
} from "../state/sftp";
import {
  allocTransferId,
  dismissTransfer,
  markTransferError,
  tidySftpError,
  trackTransfer,
  transfers,
} from "../state/transfers";
import { popupMenu } from "../contextMenu";
import { showHiddenFiles, toggleHiddenFiles } from "../state/uiPrefs";
import { ConfirmDialog } from "./ui";

const props = withDefaults(
  defineProps<{
    tabId: number;
    /** Picker entries (panel mode): "local" + "sftp:<id>" values, see FilesPanel. */
    sources?: { value: string; label: string }[];
    /** The picker entry this column currently shows. */
    sourceValue?: string;
    canClose?: boolean;
    /** When set, show this label instead of the source picker (docked mode). */
    fixedLabel?: string;
  }>(),
  { sources: () => [] },
);
const emit = defineEmits<{ "update:source": [value: string]; close: [] }>();

// Focus a freshly-mounted inline editor (rename / new-folder fields).
const vFocus = {
  mounted: (el: HTMLInputElement) => el.focus(),
};

const EDIT_INPUT_CLASS =
  "flex-1 min-w-0 bg-surface-1 border border-border text-fg rounded-md px-2 py-1 text-xs focus:outline-none focus:border-border-strong";

// `connecting` covers the gap between mount and the SSH handshake/SFTP
// subsystem coming up (and any reconnect); `unavailable` means the host
// doesn't offer SFTP; `ready` shows the listing.
type Status = "connecting" | "ready" | "unavailable";

const cwd = ref<string>("");
const entries = ref<SftpEntry[]>([]);
// Hide dot-prefixed (hidden) entries unless the shared toggle is on.
const visibleEntries = computed(() =>
  entries.value.filter((e) => showHiddenFiles.value || !e.name.startsWith(".")),
);
const loading = ref(false);
const error = ref<string | null>(null);
const status = ref<Status>("connecting");

const renamingPath = ref<string | null>(null);
const renameValue = ref("");
const creatingFolder = ref(false);
const newFolderValue = ref("");

const pendingDelete = ref<SftpEntry | null>(null);

// Transfers live in the global store (they outlive this component when the
// panel unmounts on a tab switch); this column shows the ones destined for
// the connection it's on.
const transferKey = computed(() => `sftp:${props.tabId}`);
const myTransfers = computed(() =>
  transfers.value.filter((t) => t.key === transferKey.value),
);

const unlisteners: UnlistenFn[] = [];

const crumbs = computed(() => {
  const parts = cwd.value.split("/").filter(Boolean);
  const acc: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  let p = "";
  for (const part of parts) {
    p += "/" + part;
    acc.push({ label: part, path: p });
  }
  return acc;
});

const atRoot = computed(() => cwd.value === "/" || cwd.value === "");

function basename(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(i + 1) : t;
}
function parentDir(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  if (i <= 0) return "/";
  return t.slice(0, i);
}
function joinRemote(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : dir + "/" + name;
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
  const d = new Date(mtime * 1000);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
function describeError(err: unknown): string {
  const raw = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  return tidySftpError(raw);
}

/** Map a backend error to a status change. Returns true if it was a
 *  "still establishing / not offered" condition (so callers stop). */
function applySftpError(msg: string): boolean {
  if (/not available/i.test(msg)) {
    status.value = "unavailable";
    return true;
  }
  if (/not connected/i.test(msg)) {
    status.value = "connecting";
    return true;
  }
  return false;
}

async function load(path: string): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const list = await sftpListDir(props.tabId, path);
    cwd.value = path;
    entries.value = list;
    status.value = "ready";
  } catch (err) {
    const msg = describeError(err);
    if (!applySftpError(msg)) error.value = msg;
  } finally {
    loading.value = false;
  }
}

async function init(): Promise<void> {
  entries.value = [];
  cwd.value = "";
  error.value = null;
  status.value = "connecting";
  try {
    const home = await sftpRealpath(props.tabId, ".");
    await load(home || "/");
  } catch (err) {
    if (!applySftpError(describeError(err))) status.value = "connecting";
  }
}

function navigate(e: SftpEntry): void {
  if (e.is_dir) void load(e.path);
}
function goUp(): void {
  if (!atRoot.value) void load(parentDir(cwd.value));
}
function refresh(): void {
  if (cwd.value) void load(cwd.value);
}

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
  if (p && p !== cwd.value) void load(p);
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
    await sftpMkdir(props.tabId, joinRemote(cwd.value, name));
    refresh();
  } catch (err) {
    error.value = describeError(err);
  }
}

// ---- rename ----
function startRename(e: SftpEntry): void {
  renamingPath.value = e.path;
  renameValue.value = e.name;
}
async function commitRename(e: SftpEntry): Promise<void> {
  if (renamingPath.value !== e.path) return;
  const name = renameValue.value.trim();
  renamingPath.value = null;
  if (!name || name === e.name) return;
  try {
    await sftpRename(props.tabId, e.path, joinRemote(parentDir(e.path), name));
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
  // Directory deletes are recursive and can take a while — track them in the
  // transfers list (progress arrives as a count of removed entries). File
  // deletes are instant and stay quiet, but still need a unique id.
  const id = e.is_dir
    ? trackTransfer(transferKey.value, props.tabId, e.name, "del")
    : allocTransferId();
  try {
    await sftpRemove(props.tabId, e.path, e.is_dir, id);
    refresh();
  } catch (err) {
    if (e.is_dir) markTransferError(id, describeError(err));
    else error.value = describeError(err);
  }
}

// ---- transfers ----
async function download(e: SftpEntry): Promise<void> {
  let dest: string | null;
  if (e.is_dir) {
    const parent = await openDialog({ directory: true });
    if (!parent || Array.isArray(parent)) return;
    dest = `${parent.replace(/\/+$/, "")}/${e.name}`;
  } else {
    dest = await saveDialog({ defaultPath: e.name });
  }
  if (!dest) return;
  const id = trackTransfer(transferKey.value, props.tabId, e.name, "down", e.size || null);
  try {
    await sftpDownload(props.tabId, e.path, dest, id);
  } catch (err) {
    markTransferError(id, describeError(err));
  }
}

async function upload(): Promise<void> {
  await pickAndUpload(false);
}

async function uploadFolder(): Promise<void> {
  await pickAndUpload(true);
}

async function pickAndUpload(directory: boolean): Promise<void> {
  const picked = await openDialog({ multiple: true, directory });
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  for (const localPath of paths) {
    const name = basename(localPath.replace(/\\/g, "/"));
    const id = trackTransfer(transferKey.value, props.tabId, name, "up");
    sftpUpload(props.tabId, localPath, joinRemote(cwd.value, name), id)
      .then(() => refresh())
      .catch((err) => markTransferError(id, describeError(err)));
  }
}

// ---- drag & drop: pointer-based ------------------------------------------
// Drag a row out via the shared `startFileDrag` helper (the hit-test contract
// + ghost/hint live in state/sftp.ts so this and the local browser share them).
function onRowMouseDown(ev: MouseEvent, e: SftpEntry): void {
  // Don't begin a drag from the row's action buttons or the rename field.
  if ((ev.target as HTMLElement).closest("[data-sftp-action], input")) return;
  const item: SftpDragItem = {
    source: "sftp",
    srcTabId: props.tabId,
    path: e.path,
    name: e.name,
    isDir: e.is_dir,
  };
  startFileDrag(item, ev, (t) => void onDrop(item, t));
}

// ---- native menus ----
function openToolbarMenu(): void {
  void popupMenu([
    { text: "New folder", action: startNewFolder },
    { text: "Upload files…", action: () => void upload() },
    { text: "Upload folder…", action: () => void uploadFolder() },
    null,
    {
      text: showHiddenFiles.value ? "Hide hidden files" : "Show hidden files",
      action: toggleHiddenFiles,
    },
  ]);
}
function openRowMenu(e: SftpEntry): void {
  void popupMenu([
    { text: "Download", action: () => void download(e) },
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

async function onDrop(item: SftpDragItem, t: FileDropTarget): Promise<void> {
  if (t.kind === "sftp" && t.tabId === item.srcTabId) {
    // Same connection → move into a folder (ignore drops into the current dir).
    if (t.dir === item.path || t.dir === parentDir(item.path)) return;
    try {
      await sftpRename(props.tabId, item.path, joinRemote(t.dir, item.name));
      refresh();
    } catch (err) {
      error.value = describeError(err);
    }
  } else {
    // Another column/browser → hand to the destination column to copy + track.
    deliverSftpDrop(t, item);
  }
}

// Delivered drop (this column is the destination). A local item is uploaded;
// an SFTP item from another host is relayed. Folders are recursive either way,
// so they get a confirm dialog first.
const pendingFolderDrop = ref<{ item: SftpDragItem; dstDir: string } | null>(null);

async function relayInto(d: SftpDragItem, dstDir: string): Promise<void> {
  if (d.isDir) {
    pendingFolderDrop.value = { item: d, dstDir };
    return;
  }
  if (d.source === "local") await uploadLocalInto(d, dstDir);
  else await relayRemoteInto(d, dstDir);
}

/** Copy a file/folder from another connection into `dstDir` here. */
async function relayRemoteInto(d: SftpDragItem, dstDir: string): Promise<void> {
  const id = trackTransfer(transferKey.value, props.tabId, d.name, "down");
  try {
    await sftpRelay(d.srcTabId, d.path, props.tabId, joinRemote(dstDir, d.name), id);
    refresh();
  } catch (err) {
    markTransferError(id, describeError(err));
  }
}

/** Upload a local file/folder dropped onto this connection (folders recurse in
 *  the backend `sftp_upload`). */
async function uploadLocalInto(d: SftpDragItem, dstDir: string): Promise<void> {
  const id = trackTransfer(transferKey.value, props.tabId, d.name, "up");
  try {
    await sftpUpload(props.tabId, d.path, joinRemote(dstDir, d.name), id);
    refresh();
  } catch (err) {
    markTransferError(id, describeError(err));
  }
}

function confirmFolderDrop(): void {
  const u = pendingFolderDrop.value;
  pendingFolderDrop.value = null;
  if (!u) return;
  if (u.item.source === "local") void uploadLocalInto(u.item, u.dstDir);
  else void relayRemoteInto(u.item, u.dstDir);
}

// Register as a drop target so another column's release can deliver a copy
// here (re-register when the picker changes which connection we show).
const dropHandler = (item: SftpDragItem, dstDir: string) => void relayInto(item, dstDir);
watch(
  () => props.tabId,
  (next, prev) => {
    if (prev != null) unregisterSftpTarget("sftp", prev, dropHandler);
    registerSftpTarget("sftp", next, dropHandler);
  },
  { immediate: true },
);

watch(
  () => props.tabId,
  () => void init(),
);

onMounted(async () => {
  unlisteners.push(
    await onSftpAvailability((p) => {
      if (p.tab_id !== props.tabId) return;
      if (!p.available) {
        status.value = "unavailable";
      } else if (cwd.value) {
        void load(cwd.value);
      } else {
        void init();
      }
    }),
  );
  void init();
});

onBeforeUnmount(() => {
  for (const fn of unlisteners) fn();
  unlisteners.length = 0;
  unregisterSftpTarget("sftp", props.tabId, dropHandler);
});
</script>

<template>
  <section class="flex flex-col h-full min-h-0 min-w-0 bg-surface-1 text-fg">
    <!-- header: nav actions (when ready), fixed label (docked) or connection
         picker, then close -->
    <header class="flex items-center gap-1 px-2 h-8 border-b border-border shrink-0">
      <template v-if="status === 'ready'">
        <button type="button" class="icon-btn" title="Up" :disabled="atRoot" @click="goUp">
          <ArrowUp :size="14" />
        </button>
        <button type="button" class="icon-btn" title="Refresh" @click="refresh">
          <RefreshCw :size="14" :class="{ 'animate-spin': loading }" />
        </button>
        <button type="button" class="icon-btn" title="More actions" @click="openToolbarMenu">
          <MoreHorizontal :size="14" />
        </button>
      </template>
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
        :title="fixedLabel ? 'Hide file browser' : 'Close'"
        @click="emit('close')"
      >
        <X :size="14" />
      </button>
    </header>

    <template v-if="status === 'connecting'">
      <div class="flex-1 grid place-items-center p-6 text-center text-xs text-fg-subtle">
        <div class="flex flex-col items-center gap-2">
          <RefreshCw :size="18" class="animate-spin" />
          <p>Connecting…</p>
        </div>
      </div>
    </template>

    <template v-else-if="status === 'unavailable'">
      <div class="flex-1 grid place-items-center p-6 text-center text-xs text-fg-subtle">
        <div class="flex flex-col items-center gap-2">
          <p class="font-medium text-fg-muted">SFTP unavailable</p>
          <p>This connection doesn't offer the SFTP subsystem.</p>
          <button
            type="button"
            class="mt-1 px-2.5 py-1 rounded-md border border-border text-fg-muted hover:bg-surface-2"
            @click="init"
          >
            Retry
          </button>
        </div>
      </div>
    </template>

    <template v-else>
      <!-- breadcrumb / address bar -->
      <div class="flex items-center gap-1 px-2.5 py-1.5 border-b border-border text-xs text-fg-muted shrink-0">
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
                @click="load(c.path)"
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

      <!-- listing (also a drop zone for cross-connection copy into cwd) -->
      <div
        class="flex-1 min-h-0 overflow-y-auto pb-3"
        :class="{
          'ring-1 ring-inset ring-accent/50':
            sftpDropHint && sftpDropHint.kind === 'sftp' && sftpDropHint.tabId === tabId && sftpDropHint.dir === cwd,
        }"
        data-sftp-list
        :data-sftp-tab="tabId"
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
            v-for="e in visibleEntries"
            :key="e.path"
            class="group flex items-center gap-2 px-2.5 py-1 text-xs cursor-default select-none hover:bg-surface-2"
            :class="{
              'bg-accent/15 ring-1 ring-accent/40':
                e.is_dir && sftpDropHint && sftpDropHint.kind === 'sftp' && sftpDropHint.tabId === tabId && sftpDropHint.dir === e.path,
            }"
            :data-sftp-tab="tabId"
            :data-sftp-folder="e.is_dir ? e.path : undefined"
            @mousedown="onRowMouseDown($event, e)"
            @dblclick="navigate(e)"
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
                @click="navigate(e)"
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
                data-sftp-action
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

      <!-- transfers -->
      <div v-if="myTransfers.length" class="border-t border-border px-2.5 py-1.5 shrink-0 flex flex-col gap-1.5 max-h-40 overflow-y-auto">
        <div v-for="t in myTransfers" :key="t.id" class="text-xs">
          <div class="flex items-center gap-1.5">
            <Upload v-if="t.dir === 'up'" :size="11" class="text-fg-subtle shrink-0" />
            <Trash2 v-else-if="t.dir === 'del'" :size="11" class="text-fg-subtle shrink-0" />
            <Download v-else :size="11" class="text-fg-subtle shrink-0" />
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
            <span v-else class="text-fg-subtle shrink-0 tabular-nums">
              {{ t.dir === "del" ? `${t.transferred} items` : fmtSize(t.transferred) }}
            </span>
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
    </template>

    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="pendingDelete?.is_dir ? 'Delete folder?' : 'Delete file?'"
      :message="`Permanently delete “${pendingDelete?.name}” on the remote host?`"
      confirm-label="Delete"
      cancel-label="Cancel"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />

    <ConfirmDialog
      :open="pendingFolderDrop !== null"
      :title="pendingFolderDrop?.item.source === 'local' ? 'Upload folder?' : 'Copy folder?'"
      :message="`${pendingFolderDrop?.item.source === 'local' ? 'Upload' : 'Copy'} the folder “${pendingFolderDrop?.item.name}” and all its contents to this connection?`"
      :confirm-label="pendingFolderDrop?.item.source === 'local' ? 'Upload' : 'Copy'"
      cancel-label="Cancel"
      @confirm="confirmFolderDrop"
      @cancel="pendingFolderDrop = null"
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
