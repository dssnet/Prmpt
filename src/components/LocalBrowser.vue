<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Link2,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  SquareTerminal,
  TextCursorInput,
  Trash2,
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
  openFloatingMenu,
  type FloatingMenuEntry,
  type FloatingMenuItem,
} from "../state/floatingMenu";
import { clearHighlightedPane, setHighlightedPane } from "../state/paneHighlight";
import {
  deliverSftpDrop,
  startMarqueeSelect,
  type MarqueeRect,
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
import {
  showChangedDate,
  showCreatedDate,
  showHiddenFiles,
  showSize,
  toggleChangedDate,
  toggleCreatedDate,
  toggleHiddenFiles,
  toggleSize,
} from "../state/uiPrefs";
import { columnWidth, startColumnResize } from "../state/fileColumns";
import { browserLocations } from "../state/filesPanel";
import { fitCrumbs } from "../lib/crumbs";
import { ConfirmDialog, DropdownMenu, Input } from "./ui";

const props = withDefaults(
  defineProps<{
    /** Terminals offered as cd / insert-path targets in the row context menu
     *  (one direct item if a single terminal, a submenu otherwise). */
    targets?: { id: number; title: string; focused?: boolean }[];
    /** Implicit target for a single-click path insert (the panel's seed /
     *  focused terminal); null when there is none. */
    defaultTargetTabId?: number | null;
    /** Picker entries (panel mode): "local" + "sftp:<id>" values, see FilesPanel. */
    sources?: { value: string; label: string }[];
    /** The picker entry this column currently shows. */
    sourceValue?: string;
    /** Initial folder to open on first mount (overrides the remembered cwd) —
     *  set when a panel is seeded from a terminal's cwd. */
    seedPath?: string | null;
    canClose?: boolean;
    /** Shown in the header instead of the generic title (docked mode). */
    fixedLabel?: string;
    /** Key under which this browser's cwd + nav history is remembered across
     *  remounts (browsers unmount on every tab switch). Per pane, so two local
     *  browsers tiled side-by-side don't share one folder — mirrors how the
     *  SFTP browser keys by connection id. */
    locationKey?: string;
  }>(),
  {
    canClose: false,
    sources: () => [],
    targets: () => [],
    defaultTargetTabId: null,
    seedPath: null,
    locationKey: "local",
  },
);
const emit = defineEmits<{
  "update:source": [value: string];
  /** Current folder, so the host panel can persist it onto the workspace leaf
   *  (mirrors the git panel) — restoring a saved workspace reopens here. */
  "update:cwd": [value: string];
  close: [];
}>();

const IS_WIN =
  typeof navigator !== "undefined" && /Win/i.test(navigator.platform);

// Focus a freshly-mounted inline editor (rename / new-folder fields).
// Focus a freshly-mounted inline editor (rename / new-folder fields). Also
// works on a component root (e.g. ui/Input) by reaching for its inner input.
const vFocus = {
  mounted: (el: HTMLElement) =>
    (el instanceof HTMLInputElement ? el : el.querySelector("input"))?.focus(),
};

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

// Header name filter — applies to the currently shown folder only (navigation
// resets it). Collapsed to a search icon until clicked.
const filterOpen = ref(false);
const filterText = ref("");
function onFilterBlur(): void {
  if (!filterText.value) filterOpen.value = false;
}
function closeFilter(): void {
  filterText.value = "";
  filterOpen.value = false;
}
watch(cwd, closeFilter);
// Report the folder up so it can be saved onto the workspace leaf.
watch(cwd, (v) => {
  if (v) emit("update:cwd", v);
});

// Hide dot-prefixed (hidden) entries unless the shared toggle is on; then
// apply the name filter.
const visibleEntries = computed(() => {
  const q = filterText.value.trim().toLowerCase();
  return entries.value.filter(
    (e) =>
      (showHiddenFiles.value || !e.name.startsWith(".")) &&
      (!q || e.name.toLowerCase().includes(q)),
  );
});

// Table columns: top-level refs so the template unwraps the shared widths.
const sizeW = columnWidth.size;
const changedW = columnWidth.changed;
const createdW = columnWidth.created;
// Cells after the name column (incl. the actions column) — the `..` row spans them.
const trailingCols = computed(
  () =>
    (showSize.value ? 1 : 0) +
    (showChangedDate.value ? 1 : 0) +
    (showCreatedDate.value ? 1 : 0) +
    1,
);

const renamingPath = ref<string | null>(null);
const renameValue = ref("");
const creatingFolder = ref(false);
const newFolderValue = ref("");
const pendingDelete = ref<LocalEntry[] | null>(null);

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
// The bar mounts/unmounts with path editing, so follow the ref.
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

async function load(path: string): Promise<boolean> {
  loading.value = true;
  error.value = null;
  try {
    const listing = await listLocalDir(path);
    cwd.value = listing.path;
    parent.value = listing.parent;
    entries.value = listing.entries;
    return true;
  } catch (err) {
    error.value = describeError(err);
    return false;
  } finally {
    loading.value = false;
  }
}

/** Remember the current location so the next mount (browsers unmount on
 *  every tab switch) resumes it. Keyed per pane (`locationKey`) so tiled local
 *  browsers keep independent folders. */
function saveLocation(): void {
  if (!cwd.value) return;
  browserLocations.set(props.locationKey, {
    cwd: cwd.value,
    back: [...backStack.value],
    forward: [...forwardStack.value],
  });
}

async function init(): Promise<void> {
  backStack.value = [];
  forwardStack.value = [];
  // A panel seeded from a terminal's cwd opens there directly, ignoring the
  // shared remembered location (and falling back to it / home if the seed no
  // longer loads). Success is "loaded without error", not a string match on
  // the requested path — `list_local_dir` canonicalizes (resolves symlinks),
  // so a raw shell $PWD like a symlinked path never equals the resolved
  // `cwd.value` even though it loaded the right directory.
  if (props.seedPath) {
    if (await load(props.seedPath)) return;
    error.value = null;
  }
  // Resume the last visited directory; if it no longer loads (deleted,
  // permissions…) forget it and fall back to the home directory.
  const mem = browserLocations.get(props.locationKey);
  if (mem) {
    backStack.value = [...mem.back];
    forwardStack.value = [...mem.forward];
    if (await load(mem.cwd)) return;
    browserLocations.delete(props.locationKey);
    backStack.value = [];
    forwardStack.value = [];
    error.value = null;
  }
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
/** Name-button click: modifier clicks are selection gestures (handled on the
 *  row's mousedown). Folders open on double-click only (single click selects)
 *  so a stray click can't accidentally traverse; a plain click on a file
 *  still inserts its path into the terminal. */
function onNameClick(ev: MouseEvent, e: LocalEntry): void {
  if (ev.shiftKey || ev.metaKey || ev.ctrlKey) return;
  if (!e.is_dir) insertPath([e], props.defaultTargetTabId);
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
function sendToTerminal(text: string, tabId: number | null): void {
  if (tabId == null) return;
  void writeInput(tabId, new TextEncoder().encode(text));
}
function cdInto(e: LocalEntry, tabId: number | null): void {
  sendToTerminal(`cd ${shellQuote(e.path)}\n`, tabId);
}
// A multi-selection inserts every path on one line, space-separated, so it
// drops into the terminal as one command's worth of arguments.
function insertPath(entries: LocalEntry[], tabId: number | null): void {
  sendToTerminal(entries.map((e) => shellQuote(e.path)).join(" "), tabId);
}

// ---- OS integration ----
async function openInOs(entries: LocalEntry[]): Promise<void> {
  for (const e of entries) {
    try {
      await localOpen(e.path);
    } catch (err) {
      error.value = describeError(err);
    }
  }
}
async function reveal(entries: LocalEntry[]): Promise<void> {
  for (const e of entries) {
    try {
      await localReveal(e.path);
    } catch (err) {
      error.value = describeError(err);
    }
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
// One confirm covers the whole selection; the dialog lists what's going.
const deleteTitle = computed(() => {
  const items = pendingDelete.value ?? [];
  if (items.length === 1) return items[0].is_dir ? "Delete folder?" : "Delete file?";
  return `Delete ${items.length} items?`;
});
const deleteMessage = computed(() => {
  const items = pendingDelete.value ?? [];
  if (items.length === 1) return `Permanently delete “${items[0].name}” from disk?`;
  const shown = items.slice(0, 8).map((e) => `• ${e.name}${e.is_dir ? "/" : ""}`);
  if (items.length > 8) shown.push(`…and ${items.length - 8} more`);
  return `Permanently delete these ${items.length} items from disk?\n${shown.join("\n")}`;
});

async function confirmDelete(): Promise<void> {
  const items = pendingDelete.value;
  pendingDelete.value = null;
  if (!items?.length) return;
  for (const e of items) {
    try {
      await localRemove(e.path, e.is_dir);
    } catch (err) {
      error.value = describeError(err);
    }
  }
  clearSelection();
  refresh();
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

function applyRowSelection(ev: MouseEvent, e: LocalEntry): void {
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

// ---- drag & drop ----------------------------------------------------------
// Drag source: drop onto an SFTP column to upload, or onto a local folder /
// another local column to move on disk.
function onRowMouseDown(ev: MouseEvent, e: LocalEntry): void {
  if ((ev.target as HTMLElement).closest("[data-local-action], input")) return;
  applyRowSelection(ev, e);
  // Dragging a selected row takes the whole selection (in listing order).
  const group =
    selected.value.has(e.path) && selected.value.size > 1
      ? visibleEntries.value.filter((x) => selected.value.has(x.path))
      : [e];
  // srcTabId only disambiguates SFTP sources; local items match by kind, so
  // a placeholder is fine when no terminal is targeted.
  const items: SftpDragItem[] = group.map((x) => ({
    source: "local",
    srcTabId: props.defaultTargetTabId ?? -1,
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

async function onDrop(items: SftpDragItem[], t: FileDropTarget): Promise<void> {
  if (t.kind === "local") {
    // Any local column is this same filesystem → move into the folder (skip
    // items already there).
    const movable = items.filter(
      (i) => t.dir !== i.path && t.dir !== parentOf(i.path),
    );
    if (!movable.length) return;
    try {
      for (const i of movable) {
        await localRename(i.path, joinLocal(t.dir, i.name));
      }
      refresh();
    } catch (err) {
      error.value = describeError(err);
      refresh();
    }
  } else {
    // SFTP column → hand to that column to upload + track.
    deliverSftpDrop(t, items);
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
  const id = trackTransfer("local", props.defaultTargetTabId ?? -1, d.name, "down");
  try {
    await sftpDownload(d.srcTabId, d.path, joinLocal(dstDir, d.name), id);
    refresh();
  } catch (err) {
    markTransferError(id, describeError(err));
  }
}

const dropHandler = (items: SftpDragItem[], dstDir: string) => {
  for (const item of items) void downloadInto(item, dstDir);
};
// Drop-registry id for this column (also stamped on the DOM via
// data-sftp-tab). Local columns match drops by kind, so the value only has
// to round-trip the registry — -1 stands in when no terminal is targeted.
const dropId = computed(() => props.defaultTargetTabId ?? -1);
watch(
  dropId,
  (next, prev) => {
    if (prev != null) unregisterSftpTarget("local", prev, dropHandler);
    registerSftpTarget("local", next, dropHandler);
  },
  { immediate: true },
);

// ---- native menus ----
function openToolbarMenu(): void {
  void popupMenu([
    { text: "New folder", icon: FolderPlus, action: startNewFolder },
    null,
    {
      text: showHiddenFiles.value ? "Hide hidden files" : "Show hidden files",
      icon: showHiddenFiles.value ? EyeOff : Eye,
      action: toggleHiddenFiles,
    },
    {
      text: showSize.value ? "Hide size" : "Show size",
      icon: showSize.value ? EyeOff : Eye,
      action: toggleSize,
    },
    {
      text: showChangedDate.value ? "Hide changed date" : "Show changed date",
      icon: showChangedDate.value ? EyeOff : Eye,
      action: toggleChangedDate,
    },
    {
      text: showCreatedDate.value ? "Hide created date" : "Show created date",
      icon: showCreatedDate.value ? EyeOff : Eye,
      action: toggleCreatedDate,
    },
  ]);
}
/** A "cd here" / "insert path" entry: a direct action when one terminal is
 *  available, a per-terminal submenu (hovering an entry highlights that pane)
 *  when several are, or null when there are none to target. */
function terminalMenuItem(
  text: string,
  send: (tabId: number) => void,
): FloatingMenuEntry {
  const terms = props.targets;
  if (terms.length === 0) return null;
  if (terms.length === 1) {
    const id = terms[0].id;
    return { text, action: () => send(id) };
  }
  return {
    text,
    submenu: terms.map((t) => ({
      text: t.title,
      action: () => send(t.id),
      onHover: () => setHighlightedPane(t.id),
      onLeave: () => clearHighlightedPane(),
    })),
  };
}

function openRowMenu(ev: MouseEvent, e: LocalEntry): void {
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
  const cdItem = e.is_dir
    ? terminalMenuItem("cd here in terminal", (id) => cdInto(e, id))
    : null;
  if (cdItem) cdItem.icon = SquareTerminal;
  const insertItem = terminalMenuItem(
    group.length > 1 ? `Insert ${group.length} paths into terminal` : "Insert path into terminal",
    (id) => insertPath(group, id),
  );
  if (insertItem) insertItem.icon = TextCursorInput;
  const items: FloatingMenuEntry[] = [
    { text: group.length > 1 ? `Open ${group.length} items` : "Open", icon: ExternalLink, action: () => void openInOs(group) },
    {
      text: group.length > 1 ? `Reveal ${group.length} items` : "Reveal in file manager",
      icon: FolderOpen,
      action: () => void reveal(group),
    },
  ];
  const termItems = [cdItem, insertItem].filter(Boolean) as FloatingMenuItem[];
  if (termItems.length) items.push(null, ...termItems);
  items.push(
    null,
    { text: "Rename", icon: Pencil, action: () => startRename(e) },
    null,
    {
      text: group.length > 1 ? `Delete ${group.length} items` : "Delete",
      icon: Trash2,
      danger: true,
      action: () => {
        pendingDelete.value = group;
      },
    },
  );
  openFloatingMenu(ev.clientX, ev.clientY, items);
}

onMounted(() => void init());

onBeforeUnmount(() => {
  saveLocation();
  crumbRo.disconnect();
  unregisterSftpTarget("local", dropId.value, dropHandler);
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
      <DropdownMenu
        v-else-if="sources.length"
        size="sm"
        class="min-w-0"
        title="Location"
        :options="sources"
        :model-value="sourceValue"
        @update:model-value="emit('update:source', String($event))"
      />
      <span v-else class="flex-1" />
      <div v-if="filterOpen" class="w-28 min-w-0 flex">
        <Input
          v-model="filterText"
          v-focus
          size="sm"
          placeholder="Filter"
          :spellcheck="false"
          @keydown.esc="closeFilter"
          @focusout="onFilterBlur"
        />
      </div>
      <button
        v-else
        type="button"
        class="icon-btn"
        title="Filter this folder"
        @click="filterOpen = true"
      >
        <Search :size="14" />
      </button>
      <slot name="actions" />
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

    <!-- listing (also a drop zone: SFTP items dropped here are downloaded) -->
    <div
      ref="listRef"
      class="relative flex-1 min-h-0 overflow-y-auto pb-3"
      :class="{
        'ring-1 ring-inset ring-accent/50':
          sftpDropHint && sftpDropHint.kind === 'local' && sftpDropHint.tabId === dropId && sftpDropHint.dir === cwd,
      }"
      data-sftp-list
      data-sftp-kind="local"
      :data-sftp-tab="dropId"
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

      <table class="w-full table-fixed border-separate border-spacing-0 text-xs">
        <colgroup>
          <col />
          <col v-if="showSize" :style="{ width: `${sizeW}px` }" />
          <col v-if="showChangedDate" :style="{ width: `${changedW}px` }" />
          <col v-if="showCreatedDate" :style="{ width: `${createdW}px` }" />
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
            <th v-if="showCreatedDate" class="th-cell relative text-right pr-2">
              <span class="col-grip" @mousedown="startColumnResize('created', $event)" />
              Created
            </th>
            <th class="th-cell" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-if="parent"
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
          <tr v-if="!loading && visibleEntries.length === 0 && !creatingFolder">
            <td
              :colspan="1 + trailingCols"
              class="px-2.5 py-2 text-center text-xs text-fg-subtle"
            >
              {{ filterText ? "No matches." : "Empty directory." }}
            </td>
          </tr>
          <tr
            v-for="e in visibleEntries"
            :key="e.path"
            class="group cursor-default select-none hover:bg-surface-2"
            :class="{
              'bg-accent/15 ring-1 ring-accent/40':
                e.is_dir && sftpDropHint && sftpDropHint.kind === 'local' && sftpDropHint.tabId === dropId && sftpDropHint.dir === e.path,
              'bg-accent/10': selected.has(e.path),
            }"
            data-sftp-kind="local"
            :data-sftp-tab="dropId"
            :data-sftp-folder="e.is_dir ? e.path : undefined"
            :data-marquee-path="e.path"
            @mousedown="onRowMouseDown($event, e)"
            @dblclick="e.is_dir ? navigate(e) : openInOs([e])"
            @contextmenu.prevent.stop="openRowMenu($event, e)"
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
                <button
                  v-else
                  type="button"
                  class="flex-1 min-w-0 truncate text-left"
                  :class="e.is_dir ? 'text-fg' : 'text-fg-muted'"
                  @click="onNameClick($event, e)"
                >
                  {{ e.name }}
                </button>
              </div>
            </td>
            <td v-if="showSize" class="pr-2 py-1 text-right text-fg-subtle tabular-nums truncate">
              {{ e.is_dir ? "" : fmtSize(e.size) }}
            </td>
            <td v-if="showChangedDate" class="pr-2 py-1 text-right text-fg-subtle truncate">
              {{ fmtDate(e.mtime) }}
            </td>
            <td v-if="showCreatedDate" class="pr-2 py-1 text-right text-fg-subtle truncate">
              {{ fmtDate(e.created) }}
            </td>
            <td class="py-0.5">
              <span
                v-if="renamingPath !== e.path"
                data-local-action
                class="flex justify-end opacity-0 group-hover:opacity-100"
              >
                <button type="button" class="icon-btn" title="Actions" @click.stop="openRowMenu($event, e)">
                  <MoreHorizontal :size="13" />
                </button>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
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
      :title="deleteTitle"
      :message="deleteMessage"
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
