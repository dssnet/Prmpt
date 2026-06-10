<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  ArrowRight,
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
  startMarqueeSelect,
  type MarqueeRect,
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
import {
  showChangedDate,
  showHiddenFiles,
  showSize,
  toggleChangedDate,
  toggleHiddenFiles,
  toggleSize,
} from "../state/uiPrefs";
import { columnWidth, startColumnResize } from "../state/fileColumns";
import { browserLocations } from "../state/filesPanel";
import { fitCrumbs } from "../lib/crumbs";
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

const pendingDelete = ref<SftpEntry[] | null>(null);

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

// Paths wider than the bar collapse just enough of the middle into an "…"
// menu: root › … › nearest ancestors that fit › current. The hidden levels
// stay reachable via the menu (deepest first). Width comes from a
// ResizeObserver on the bar; the fitting math lives in lib/crumbs.ts.
const crumbBarRef = ref<HTMLElement | null>(null);
const crumbAvail = ref(0);
const crumbFont = ref("12px sans-serif");
const crumbRo = new ResizeObserver((entries) => {
  crumbAvail.value = entries[0]?.contentRect.width ?? 0;
});
// The bar mounts/unmounts with status + path editing, so follow the ref.
watch(crumbBarRef, (el, prev) => {
  if (prev) crumbRo.unobserve(prev);
  if (el) {
    const s = getComputedStyle(el);
    crumbFont.value = s.font || `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    crumbAvail.value = el.clientWidth;
    crumbRo.observe(el);
  }
});

const crumbItems = computed(() =>
  fitCrumbs(crumbs.value, crumbAvail.value, crumbFont.value),
);
const hiddenCrumbs = computed(() => {
  const items = crumbItems.value;
  if (!items.some((i) => i.kind === "ellipsis")) return [];
  const tail = items.length - 2; // root + … + tail crumbs
  return crumbs.value.slice(1, crumbs.value.length - tail);
});
function openCrumbMenu(): void {
  void popupMenu(
    hiddenCrumbs.value
      .slice()
      .reverse()
      .map((c) => ({ text: c.label, action: () => void visit(c.path) })),
  );
}

const atRoot = computed(() => cwd.value === "/" || cwd.value === "");

// Table columns: top-level refs so the template unwraps the shared widths.
// (No created column here — the SFTP protocol doesn't report creation time.)
const sizeW = columnWidth.size;
const changedW = columnWidth.changed;
// Cells after the name column (incl. the actions column) — the `..` row spans them.
const trailingCols = computed(
  () => (showSize.value ? 1 : 0) + (showChangedDate.value ? 1 : 0) + 1,
);

// ---- back/forward history ----
const backStack = ref<string[]>([]);
const forwardStack = ref<string[]>([]);
const canGoBack = computed(() => backStack.value.length > 0);
const canGoForward = computed(() => forwardStack.value.length > 0);

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

/** Remember the current location so the next mount of this connection's
 *  browser (the panel unmounts on every tab switch) resumes it. */
function saveLocation(tabId: number): void {
  if (!cwd.value) return;
  browserLocations.set(`sftp:${tabId}`, {
    cwd: cwd.value,
    back: [...backStack.value],
    forward: [...forwardStack.value],
  });
}

async function init(): Promise<void> {
  entries.value = [];
  cwd.value = "";
  backStack.value = [];
  forwardStack.value = [];
  error.value = null;
  status.value = "connecting";
  // Resume the last visited directory first. A "not connected yet" failure
  // leaves cwd empty and status "connecting"; the availability event re-runs
  // init() and retries. A real failure (directory gone) falls through to home.
  const mem = browserLocations.get(`sftp:${props.tabId}`);
  if (mem) {
    backStack.value = [...mem.back];
    forwardStack.value = [...mem.forward];
    await load(mem.cwd);
    if (cwd.value === mem.cwd) return; // restored
    if (error.value == null) return; // not connected yet / unavailable
    // The remembered directory no longer loads (deleted, permissions…) —
    // forget it and fall back to the home directory.
    browserLocations.delete(`sftp:${props.tabId}`);
    backStack.value = [];
    forwardStack.value = [];
    error.value = null;
  }
  try {
    const home = await sftpRealpath(props.tabId, ".");
    await load(home || "/");
  } catch (err) {
    if (!applySftpError(describeError(err))) status.value = "connecting";
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
// Folders open on double-click only (single click selects) so a stray click
// can't accidentally traverse into a directory.
function navigate(e: SftpEntry): void {
  if (e.is_dir) void visit(e.path);
}
function goUp(): void {
  if (!atRoot.value) void visit(parentDir(cwd.value));
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
  if (p && p !== cwd.value) void visit(p);
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
// One confirm covers the whole selection; the dialog lists what's going.
const deleteTitle = computed(() => {
  const items = pendingDelete.value ?? [];
  if (items.length === 1) return items[0].is_dir ? "Delete folder?" : "Delete file?";
  return `Delete ${items.length} items?`;
});
const deleteMessage = computed(() => {
  const items = pendingDelete.value ?? [];
  if (items.length === 1) {
    return `Permanently delete “${items[0].name}” on the remote host?`;
  }
  const shown = items.slice(0, 8).map((e) => `• ${e.name}${e.is_dir ? "/" : ""}`);
  if (items.length > 8) shown.push(`…and ${items.length - 8} more`);
  return `Permanently delete these ${items.length} items on the remote host?\n${shown.join("\n")}`;
});

async function confirmDelete(): Promise<void> {
  const items = pendingDelete.value;
  pendingDelete.value = null;
  if (!items?.length) return;
  await Promise.all(
    items.map(async (e) => {
      // Directory deletes are recursive and can take a while — track them in
      // the transfers list (progress arrives as a count of removed entries).
      // File deletes are instant and stay quiet, but still need a unique id.
      const id = e.is_dir
        ? trackTransfer(transferKey.value, props.tabId, e.name, "del")
        : allocTransferId();
      try {
        await sftpRemove(props.tabId, e.path, e.is_dir, id);
      } catch (err) {
        if (e.is_dir) markTransferError(id, describeError(err));
        else error.value = describeError(err);
      }
    }),
  );
  clearSelection();
  refresh();
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

// ---- selection -------------------------------------------------------------
// Multi-select for drag & drop: click selects, Cmd/Ctrl+click toggles,
// Shift+click extends from the last plain/toggled row. Dragging any selected
// row drags the whole selection. Navigation clears it.
const selected = ref<Set<string>>(new Set());
let selectionAnchor: string | null = null;

function clearSelection(): void {
  if (selected.value.size) selected.value = new Set();
  selectionAnchor = null;
}
watch(cwd, clearSelection);

function applyRowSelection(ev: MouseEvent, e: SftpEntry): void {
  const paths = visibleEntries.value.map((x) => x.path);
  if (ev.shiftKey && selectionAnchor != null && paths.includes(selectionAnchor)) {
    const a = paths.indexOf(selectionAnchor);
    const b = paths.indexOf(e.path);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    selected.value = new Set(paths.slice(lo, hi + 1));
  } else if (ev.metaKey || ev.ctrlKey) {
    const next = new Set(selected.value);
    if (next.has(e.path)) next.delete(e.path);
    else next.add(e.path);
    selected.value = next;
    selectionAnchor = e.path;
  } else if (!selected.value.has(e.path)) {
    selected.value = new Set([e.path]);
    selectionAnchor = e.path;
  }
  // A plain mousedown on an already-selected row keeps the group so it can be
  // dragged; if it turns out to be a click, startFileDrag's onClick collapses.
}

// Mousedown on the empty area: clear (plain) or keep (modifier) the current
// selection, then start a rubber-band selection — dragging draws a rectangle
// that selects every row it touches.
const listRef = ref<HTMLElement | null>(null);
const marqueeRect = ref<MarqueeRect | null>(null);

function onListMouseDown(ev: MouseEvent): void {
  if ((ev.target as HTMLElement).closest("tr, input, button")) return;
  const additive = ev.shiftKey || ev.metaKey || ev.ctrlKey;
  if (!additive) clearSelection();
  if (!listRef.value) return;
  startMarqueeSelect(listRef.value, ev, new Set(selected.value), (sel, rect) => {
    selected.value = sel;
    marqueeRect.value = rect;
  });
}

// ---- drag & drop: pointer-based ------------------------------------------
// Drag a row out via the shared `startFileDrag` helper (the hit-test contract
// + ghost/hint live in state/sftp.ts so this and the local browser share them).
function onRowMouseDown(ev: MouseEvent, e: SftpEntry): void {
  // Don't begin a drag from the row's action buttons or the rename field.
  if ((ev.target as HTMLElement).closest("[data-sftp-action], input")) return;
  applyRowSelection(ev, e);
  // Dragging a selected row takes the whole selection (in listing order).
  const group =
    selected.value.has(e.path) && selected.value.size > 1
      ? visibleEntries.value.filter((x) => selected.value.has(x.path))
      : [e];
  const items: SftpDragItem[] = group.map((x) => ({
    source: "sftp",
    srcTabId: props.tabId,
    path: x.path,
    name: x.name,
    isDir: x.is_dir,
  }));
  startFileDrag(items, ev, (t) => void onDrop(items, t), () => {
    // Plain click (no drag) on a selected row collapses a multi-selection.
    if (!ev.shiftKey && !ev.metaKey && !ev.ctrlKey) {
      selected.value = new Set([e.path]);
      selectionAnchor = e.path;
    }
  });
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
    {
      text: showSize.value ? "Hide size" : "Show size",
      action: toggleSize,
    },
    // No created-date item: the SFTP protocol doesn't report creation time.
    {
      text: showChangedDate.value ? "Hide changed date" : "Show changed date",
      action: toggleChangedDate,
    },
  ]);
}
function openRowMenu(e: SftpEntry): void {
  // Right-clicking outside the current selection re-targets it to this row
  // (Finder-style); inside it, the menu acts on the whole selection.
  if (!selected.value.has(e.path)) {
    selected.value = new Set([e.path]);
    selectionAnchor = e.path;
  }
  const group =
    selected.value.size > 1
      ? visibleEntries.value.filter((x) => selected.value.has(x.path))
      : [e];
  void popupMenu([
    { text: "Download", action: () => void download(e) },
    { text: "Rename", action: () => startRename(e) },
    null,
    {
      text: group.length > 1 ? `Delete ${group.length} items` : "Delete",
      action: () => {
        pendingDelete.value = group;
      },
    },
  ]);
}

async function onDrop(items: SftpDragItem[], t: FileDropTarget): Promise<void> {
  if (t.kind === "sftp" && t.tabId === props.tabId) {
    // Same connection → move into a folder (skip items already there).
    const movable = items.filter(
      (i) => t.dir !== i.path && t.dir !== parentDir(i.path),
    );
    if (!movable.length) return;
    try {
      for (const i of movable) {
        await sftpRename(props.tabId, i.path, joinRemote(t.dir, i.name));
      }
      refresh();
    } catch (err) {
      error.value = describeError(err);
      refresh();
    }
  } else {
    // Another column/browser → hand to the destination column to copy + track.
    deliverSftpDrop(t, items);
  }
}

// Delivered drop (this column is the destination). Local items are uploaded;
// SFTP items from another host are relayed. Folders are recursive either way,
// so they get one confirm dialog (covering all dropped folders) first.
const pendingFolderDrop = ref<{ items: SftpDragItem[]; dstDir: string } | null>(null);

function relayInto(items: SftpDragItem[], dstDir: string): void {
  for (const d of items) {
    if (d.isDir) continue;
    if (d.source === "local") void uploadLocalInto(d, dstDir);
    else void relayRemoteInto(d, dstDir);
  }
  const folders = items.filter((d) => d.isDir);
  if (folders.length) pendingFolderDrop.value = { items: folders, dstDir };
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

// Dialog copy: the verb tracks the items' source (all items in one drop come
// from the same browser), the label collapses multi-folder drops to a count.
const folderDropVerb = computed(() =>
  pendingFolderDrop.value?.items[0]?.source === "local" ? "Upload" : "Copy",
);
const folderDropCount = computed(() => pendingFolderDrop.value?.items.length ?? 0);
const folderDropLabel = computed(() => {
  const items = pendingFolderDrop.value?.items ?? [];
  return items.length === 1
    ? `the folder “${items[0].name}”`
    : `${items.length} folders`;
});

function confirmFolderDrop(): void {
  const u = pendingFolderDrop.value;
  pendingFolderDrop.value = null;
  if (!u) return;
  for (const item of u.items) {
    if (item.source === "local") void uploadLocalInto(item, u.dstDir);
    else void relayRemoteInto(item, u.dstDir);
  }
}

// Register as a drop target so another column's release can deliver a copy
// here (re-register when the picker changes which connection we show).
const dropHandler = (items: SftpDragItem[], dstDir: string) => relayInto(items, dstDir);
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
  (_next, prev) => {
    // Same component instance switched to another connection (e.g. the
    // column picker): bank the old connection's location before resetting.
    if (prev != null) saveLocation(prev);
    void init();
  },
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
  saveLocation(props.tabId);
  crumbRo.disconnect();
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
      <slot name="actions" />
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
          <div
            ref="crumbBarRef"
            class="flex items-center gap-0.5 flex-1 min-w-0 overflow-hidden whitespace-nowrap"
          >
            <template v-for="(c, i) in crumbItems" :key="c.kind === 'crumb' ? c.path : '…'">
              <ChevronRight v-if="i > 0" :size="11" class="text-fg-subtle shrink-0" />
              <button
                v-if="c.kind === 'crumb'"
                type="button"
                class="px-1 py-0.5 rounded hover:bg-surface-2 truncate max-w-[140px] min-w-0"
                :class="i === crumbItems.length - 1 ? 'text-fg font-medium' : 'text-fg-muted'"
                @click="visit(c.path)"
              >
                {{ c.label }}
              </button>
              <button
                v-else
                type="button"
                class="px-1 py-0.5 rounded hover:bg-surface-2 text-fg-muted shrink-0"
                title="Show full path"
                @click="openCrumbMenu"
              >
                …
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
        ref="listRef"
        class="relative flex-1 min-h-0 overflow-y-auto pb-3"
        :class="{
          'ring-1 ring-inset ring-accent/50':
            sftpDropHint && sftpDropHint.kind === 'sftp' && sftpDropHint.tabId === tabId && sftpDropHint.dir === cwd,
        }"
        data-sftp-list
        :data-sftp-tab="tabId"
        :data-sftp-cwd="cwd"
        @mousedown="onListMouseDown"
      >
        <!-- Rubber-band selection rectangle (content coords, scrolls with rows). -->
        <div
          v-if="marqueeRect"
          class="absolute z-10 pointer-events-none border border-accent/60 bg-accent/10 rounded-sm"
          :style="{
            left: `${marqueeRect.x}px`,
            top: `${marqueeRect.y}px`,
            width: `${marqueeRect.w}px`,
            height: `${marqueeRect.h}px`,
          }"
        />
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

        <table class="w-full table-fixed border-separate border-spacing-0 text-xs">
          <colgroup>
            <col />
            <col v-if="showSize" :style="{ width: `${sizeW}px` }" />
            <col v-if="showChangedDate" :style="{ width: `${changedW}px` }" />
            <col style="width: 28px" />
          </colgroup>
          <thead>
            <tr>
              <th class="th-cell text-left pl-2.5 pr-1">Name</th>
              <th v-if="showSize" class="th-cell relative text-right pr-2">
                <span class="col-grip" @mousedown="startColumnResize('size', $event)" />
                Size
              </th>
              <th v-if="showChangedDate" class="th-cell relative text-right pr-2">
                <span class="col-grip" @mousedown="startColumnResize('changed', $event)" />
                Changed
              </th>
              <th class="th-cell" />
            </tr>
          </thead>
          <tbody>
            <tr
              v-if="!atRoot"
              class="group cursor-default select-none hover:bg-surface-2"
              @dblclick="goUp"
            >
              <td class="pl-2.5 pr-1 py-1">
                <div class="flex items-center gap-2 min-w-0">
                  <Folder :size="15" class="shrink-0 text-accent" />
                  <span class="flex-1 min-w-0 truncate text-fg">..</span>
                </div>
              </td>
              <td :colspan="trailingCols" />
            </tr>
            <tr
              v-for="e in visibleEntries"
              :key="e.path"
              class="group cursor-default select-none hover:bg-surface-2"
              :class="{
                'bg-accent/15 ring-1 ring-accent/40':
                  e.is_dir && sftpDropHint && sftpDropHint.kind === 'sftp' && sftpDropHint.tabId === tabId && sftpDropHint.dir === e.path,
                'bg-accent/10': selected.has(e.path),
              }"
              :data-sftp-tab="tabId"
              :data-sftp-folder="e.is_dir ? e.path : undefined"
              :data-marquee-path="e.path"
              @mousedown="onRowMouseDown($event, e)"
              @dblclick="navigate(e)"
              @contextmenu.prevent.stop="openRowMenu(e)"
            >
              <td class="pl-2.5 pr-1 py-1">
                <div class="flex items-center gap-2 min-w-0">
                  <Link2 v-if="e.is_symlink" :size="15" class="shrink-0 text-accent" />
                  <Folder v-else-if="e.is_dir" :size="15" class="shrink-0 text-accent" />
                  <FileIcon v-else :size="15" class="shrink-0 text-fg-subtle" />

                  <input
                    v-if="renamingPath === e.path"
                    v-model="renameValue"
                    v-focus
                    :class="EDIT_INPUT_CLASS"
                    @keydown.enter="commitRename(e)"
                    @keydown.esc="renamingPath = null"
                    @blur="commitRename(e)"
                  />
                  <span
                    v-else
                    class="flex-1 min-w-0 truncate text-left"
                    :class="e.is_dir ? 'text-fg' : 'text-fg-muted'"
                  >
                    {{ e.name }}
                  </span>
                </div>
              </td>
              <td v-if="showSize" class="pr-2 py-1 text-right text-fg-subtle tabular-nums truncate">
                {{ e.is_dir ? "" : fmtSize(e.size) }}
              </td>
              <td v-if="showChangedDate" class="pr-2 py-1 text-right text-fg-subtle truncate">
                {{ fmtDate(e.mtime) }}
              </td>
              <td class="py-0.5">
                <span
                  v-if="renamingPath !== e.path"
                  data-sftp-action
                  class="flex justify-end opacity-0 group-hover:opacity-100"
                >
                  <button type="button" class="icon-btn" title="Actions" @click.stop="openRowMenu(e)">
                    <MoreHorizontal :size="13" />
                  </button>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
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
      :title="deleteTitle"
      :message="deleteMessage"
      confirm-label="Delete"
      cancel-label="Cancel"
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />

    <ConfirmDialog
      :open="pendingFolderDrop !== null"
      :title="`${folderDropVerb} ${folderDropCount === 1 ? 'folder' : 'folders'}?`"
      :message="`${folderDropVerb} ${folderDropLabel} and all ${folderDropCount === 1 ? 'its' : 'their'} contents to this connection?`"
      :confirm-label="folderDropVerb"
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
.th-cell {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface-1, #181825);
  border-bottom: 1px solid var(--border, #313244);
  padding-top: 3px;
  padding-bottom: 3px;
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-subtle, #9399b2);
  user-select: none;
  white-space: nowrap;
}
/* Drag grip on a column's left edge (the name column absorbs the change). */
.col-grip {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -3px;
  width: 7px;
  cursor: col-resize;
  z-index: 2;
}
.col-grip::after {
  content: "";
  position: absolute;
  left: 3px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border, #313244);
}
.col-grip:hover::after {
  left: 2px;
  width: 3px;
  background: var(--accent, #89b4fa);
}
</style>
