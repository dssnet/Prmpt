<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  ArrowUp,
  ChevronRight,
  File as FileIcon,
  Folder,
  Link2,
  MoreHorizontal,
  RefreshCw,
  X,
} from "lucide-vue-next";

import {
  listLocalDir,
  localHomeDir,
  localMkdir,
  localOpen,
  localRemove,
  localRename,
  localReveal,
  writeInput,
  type LocalEntry,
} from "../ipc";
import { popupMenu } from "../contextMenu";
import { deliverSftpDrop, startFileDrag, type SftpDragItem } from "../state/sftp";
import { ConfirmDialog } from "./ui";

const props = withDefaults(
  defineProps<{
    /** Terminal tab to target for `cd` / insert-path (active tab or pane). */
    targetTabId: number;
    canClose?: boolean;
    /** Shown in the header instead of the generic title (docked mode). */
    fixedLabel?: string;
  }>(),
  { canClose: false },
);
const emit = defineEmits<{ close: [] }>();

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
  try {
    await load(await localHomeDir());
  } catch (err) {
    error.value = describeError(err);
  }
}

function navigate(e: LocalEntry): void {
  if (e.is_dir) void load(e.path);
}
function goUp(): void {
  if (parent.value) void load(parent.value);
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

// ---- drag source: drop onto an SFTP browser to upload ----
function onRowMouseDown(ev: MouseEvent, e: LocalEntry): void {
  if ((ev.target as HTMLElement).closest("[data-local-action], input")) return;
  const item: SftpDragItem = {
    source: "local",
    srcTabId: props.targetTabId,
    path: e.path,
    name: e.name,
    isDir: e.is_dir,
  };
  startFileDrag(item, ev, (t) => deliverSftpDrop(t.tabId, item, t.dir));
}

// ---- native menus ----
function openToolbarMenu(): void {
  void popupMenu([{ text: "New folder", action: startNewFolder }]);
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
</script>

<template>
  <section class="flex flex-col h-full min-h-0 min-w-0 bg-surface-1 text-fg">
    <!-- header -->
    <header class="flex items-center gap-1.5 px-2 h-8 border-b border-border shrink-0">
      <span class="flex-1 min-w-0 truncate text-xs font-semibold" :title="fixedLabel">
        {{ fixedLabel || "Files" }}
      </span>
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

    <!-- toolbar -->
    <div class="flex items-center gap-1 px-2 h-8 border-b border-border shrink-0">
      <button type="button" class="icon-btn" title="Up" :disabled="!parent" @click="goUp">
        <ArrowUp :size="14" />
      </button>
      <button type="button" class="icon-btn" title="Refresh" @click="refresh">
        <RefreshCw :size="14" :class="{ 'animate-spin': loading }" />
      </button>
      <button type="button" class="icon-btn" title="More actions" @click="openToolbarMenu">
        <MoreHorizontal :size="14" />
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
    <div class="flex-1 min-h-0 overflow-y-auto pb-3">
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
