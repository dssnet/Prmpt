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
  FolderPlus,
  Link2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-vue-next";

import {
  onSftpTransferProgress,
  sftpDownload,
  sftpListDir,
  sftpMkdir,
  sftpRealpath,
  sftpRemove,
  sftpRename,
  sftpUpload,
  onSftpAvailability,
  type SftpEntry,
} from "../ipc";
import { ConfirmDialog } from "./ui";

const props = defineProps<{ tabId: number; hostLabel?: string }>();
const emit = defineEmits<{ close: [] }>();

// Focus a freshly-mounted inline editor (rename / new-folder fields).
const vFocus = {
  mounted: (el: HTMLInputElement) => el.focus(),
};

const EDIT_INPUT_CLASS =
  "flex-1 min-w-0 bg-surface-1 border border-border text-fg rounded-md px-2 py-1 text-xs focus:outline-none focus:border-border-strong";

// `connecting` covers the gap between the panel mounting and the SSH
// handshake/SFTP subsystem coming up (and any reconnect); `unavailable` means
// the host doesn't offer SFTP; `ready` shows the listing.
type Status = "connecting" | "ready" | "unavailable";

const cwd = ref<string>("");
const entries = ref<SftpEntry[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const status = ref<Status>("connecting");

// Inline rename + new-folder editing state.
const renamingPath = ref<string | null>(null);
const renameValue = ref("");
const creatingFolder = ref(false);
const newFolderValue = ref("");

// Delete confirmation.
const pendingDelete = ref<SftpEntry | null>(null);

// In-flight transfers, keyed by a monotonic id.
interface Transfer {
  id: number;
  name: string;
  dir: "up" | "down";
  transferred: number;
  total: number | null;
  done: boolean;
  error: string | null;
}
const transfers = ref<Transfer[]>([]);
let nextTransferId = 1;

// Drag-to-move payload. WKWebView's HTML5 drag doesn't reliably expose
// dataTransfer during dragover, so the dragged entry is held here instead
// (this is in-panel only — no OS boundary is crossed).
const dragPath = ref<string | null>(null);
const dragOverPath = ref<string | null>(null);

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
  return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}

/** Map a backend error to a status change. Returns true if it was a
 *  "still establishing / not offered" condition (so callers stop). */
function applySftpError(msg: string): boolean {
  if (/not available/i.test(msg)) {
    status.value = "unavailable";
    return true;
  }
  if (/not connected/i.test(msg)) {
    // Pre-handshake race or a reconnect in flight: wait for the availability
    // event rather than showing a hard error.
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
    // A transient op error (permission denied, etc.) keeps the current view.
    if (!applySftpError(msg)) error.value = msg;
  } finally {
    loading.value = false;
  }
}

async function init(): Promise<void> {
  // Reset for a (possibly) different tab / fresh (re)connect.
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

// ---- new folder ----
function startNewFolder(): void {
  creatingFolder.value = true;
  newFolderValue.value = "";
}
async function commitNewFolder(): Promise<void> {
  // Guard the enter→blur double-fire: enter clears the flag first.
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
  // Guard the enter→blur double-fire: enter clears the path first.
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
  try {
    await sftpRemove(props.tabId, e.path, e.is_dir);
    refresh();
  } catch (err) {
    error.value = describeError(err);
  }
}

// ---- transfers ----
async function download(e: SftpEntry): Promise<void> {
  const dest = await saveDialog({ defaultPath: e.name });
  if (!dest) return;
  const id = nextTransferId++;
  transfers.value = [
    ...transfers.value,
    { id, name: e.name, dir: "down", transferred: 0, total: e.size || null, done: false, error: null },
  ];
  try {
    await sftpDownload(props.tabId, e.path, dest, id);
  } catch (err) {
    markTransferError(id, describeError(err));
  }
}

async function upload(): Promise<void> {
  const picked = await openDialog({ multiple: true });
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  for (const localPath of paths) {
    const name = basename(localPath.replace(/\\/g, "/"));
    const id = nextTransferId++;
    transfers.value = [
      ...transfers.value,
      { id, name, dir: "up", transferred: 0, total: null, done: false, error: null },
    ];
    sftpUpload(props.tabId, localPath, joinRemote(cwd.value, name), id)
      .then(() => refresh())
      .catch((err) => markTransferError(id, describeError(err)));
  }
}

function markTransferError(id: number, message: string): void {
  transfers.value = transfers.value.map((t) =>
    t.id === id ? { ...t, done: true, error: message } : t,
  );
}

function dismissTransfer(id: number): void {
  transfers.value = transfers.value.filter((t) => t.id !== id);
}

// ---- in-panel drag to move ----
function onDragStart(e: SftpEntry, ev: DragEvent): void {
  dragPath.value = e.path;
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = "move";
    // Some payload is required for the drag to start in WebKit.
    ev.dataTransfer.setData("text/plain", e.path);
  }
}
function onDragEnd(): void {
  dragPath.value = null;
  dragOverPath.value = null;
}
function canDropInto(target: SftpEntry): boolean {
  if (!dragPath.value || !target.is_dir) return false;
  if (dragPath.value === target.path) return false;
  // Don't drop an item back into its own parent (no-op) or into itself.
  if (parentDir(dragPath.value) === target.path) return false;
  return true;
}
function onRowDragOver(target: SftpEntry, ev: DragEvent): void {
  if (!canDropInto(target)) return;
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
  dragOverPath.value = target.path;
}
async function onRowDrop(target: SftpEntry): Promise<void> {
  const from = dragPath.value;
  dragOverPath.value = null;
  dragPath.value = null;
  if (!from || !canDropInto(target)) return;
  try {
    await sftpRename(props.tabId, from, joinRemote(target.path, basename(from)));
    refresh();
  } catch (err) {
    error.value = describeError(err);
  }
}

watch(
  () => props.tabId,
  () => void init(),
);

onMounted(async () => {
  unlisteners.push(
    await onSftpTransferProgress((p) => {
      if (p.tab_id !== props.tabId) return;
      transfers.value = transfers.value.map((t) =>
        t.id === p.transfer_id
          ? {
              ...t,
              transferred: p.transferred,
              total: p.total ?? t.total,
              done: p.done,
              error: p.error ?? t.error,
            }
          : t,
      );
      // Auto-dismiss a successful transfer shortly after it finishes.
      if (p.done && !p.error) {
        const id = p.transfer_id;
        setTimeout(() => dismissTransfer(id), 2500);
      }
    }),
  );
  // The SSH handshake finishes after the panel mounts, so the first load
  // usually races ahead of it; this event tells us when SFTP is actually up
  // (and fires again on every reconnect).
  unlisteners.push(
    await onSftpAvailability((p) => {
      if (p.tab_id !== props.tabId) return;
      if (!p.available) {
        status.value = "unavailable";
      } else if (cwd.value) {
        // Reconnect: reload the directory the user was in, in place.
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
});
</script>

<template>
  <aside class="sftp-panel flex flex-col h-full min-h-0 bg-surface-1 border-l border-border text-fg">
    <!-- header -->
    <header class="flex items-center gap-2 px-3 h-9 border-b border-border shrink-0">
      <span class="text-xs font-semibold truncate flex-1">
        {{ hostLabel || "Files" }}
      </span>
      <button
        type="button"
        class="icon-btn"
        title="Hide file browser"
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
      <!-- toolbar -->
      <div class="flex items-center gap-1 px-2 h-8 border-b border-border shrink-0">
        <button type="button" class="icon-btn" title="Up" :disabled="atRoot" @click="goUp">
          <ArrowUp :size="14" />
        </button>
        <button type="button" class="icon-btn" title="Refresh" @click="refresh">
          <RefreshCw :size="14" :class="{ 'animate-spin': loading }" />
        </button>
        <button type="button" class="icon-btn" title="New folder" @click="startNewFolder">
          <FolderPlus :size="14" />
        </button>
        <button type="button" class="icon-btn" title="Upload files" @click="upload">
          <Upload :size="14" />
        </button>
      </div>

      <!-- breadcrumb -->
      <div class="flex items-center flex-wrap gap-0.5 px-2.5 py-1.5 border-b border-border text-xs text-fg-muted shrink-0">
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

      <!-- listing -->
      <div class="flex-1 min-h-0 overflow-y-auto">
        <!-- new folder inline row -->
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
          v-if="!loading && entries.length === 0 && !creatingFolder"
          class="px-3 py-6 text-center text-xs text-fg-subtle"
        >
          Empty directory.
        </p>

        <ul class="py-0.5">
          <li
            v-for="e in entries"
            :key="e.path"
            class="group flex items-center gap-2 px-2.5 py-1 text-xs cursor-default select-none hover:bg-surface-2"
            :class="{ 'bg-accent/15 ring-1 ring-accent/40': dragOverPath === e.path }"
            draggable="true"
            @dragstart="onDragStart(e, $event)"
            @dragend="onDragEnd"
            @dragover="onRowDragOver(e, $event)"
            @dragleave="dragOverPath === e.path && (dragOverPath = null)"
            @drop="onRowDrop(e)"
            @dblclick="navigate(e)"
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
              <span class="shrink-0 w-20 text-right text-fg-subtle hidden xl:inline">
                {{ fmtDate(e.mtime) }}
              </span>
              <span class="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                <button
                  v-if="!e.is_dir"
                  type="button"
                  class="icon-btn"
                  title="Download"
                  @click.stop="download(e)"
                >
                  <Download :size="13" />
                </button>
                <button type="button" class="icon-btn" title="Rename" @click.stop="startRename(e)">
                  <Pencil :size="13" />
                </button>
                <button
                  type="button"
                  class="icon-btn icon-btn-danger"
                  title="Delete"
                  @click.stop="pendingDelete = e"
                >
                  <Trash2 :size="13" />
                </button>
              </span>
            </template>
          </li>
        </ul>
      </div>

      <!-- transfers -->
      <div v-if="transfers.length" class="border-t border-border px-2.5 py-1.5 shrink-0 flex flex-col gap-1.5 max-h-40 overflow-y-auto">
        <div v-for="t in transfers" :key="t.id" class="text-xs">
          <div class="flex items-center gap-1.5">
            <Upload v-if="t.dir === 'up'" :size="11" class="text-fg-subtle shrink-0" />
            <Download v-else :size="11" class="text-fg-subtle shrink-0" />
            <span class="flex-1 min-w-0 truncate" :class="t.error ? 'text-danger' : 'text-fg-muted'">
              {{ t.name }}
            </span>
            <span v-if="t.error" class="text-danger shrink-0">failed</span>
            <span v-else-if="t.done" class="text-accent shrink-0">done</span>
            <span v-else-if="t.total" class="text-fg-subtle shrink-0 tabular-nums">
              {{ Math.floor((t.transferred / t.total) * 100) }}%
            </span>
            <span v-else class="text-fg-subtle shrink-0 tabular-nums">{{ fmtSize(t.transferred) }}</span>
            <button type="button" class="icon-btn" title="Dismiss" @click="dismissTransfer(t.id)">
              <X :size="11" />
            </button>
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
  </aside>
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
.icon-btn-danger:hover:not(:disabled) {
  color: var(--danger, #f38ba8);
}
</style>
