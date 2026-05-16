<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";

import { recordHostFingerprint } from "./db";
import { encodeKey } from "./input";
import {
  attachTab,
  closeCurrentWindow,
  currentWindowLabel,
  fullDiskAccessGranted,
  listTabsForWindow,
  onExit,
  onMenuCopy,
  onMenuPaste,
  onMenuSelectAll,
  onRender,
  onSshHostKeyFirstConnect,
  onSshHostKeyMismatch,
  onSshPortForwardError,
  onTabAttached,
  scrollTab,
  showContextMenu,
  tearOffTab,
  windowAtScreenPoint,
  writeInput,
  type Config,
  type SshHostKeyMismatch,
} from "./ipc";
import {
  attachTab as attachTabLocal,
  closeTabAndForget,
  dropTabIntoTarget,
  handleExit,
  handleRender,
  hydrateTabs,
  removeTabLocal,
  setActive,
  spawnTerminal,
  useTabs,
  type TabHydrateInfo,
} from "./state/tabs";
import {
  applyTerminalBg,
  clearSelection,
  copyCurrentSelection,
  computeDims,
  resolveDropAt,
  focusCanvas,
  getCellMetrics,
  hasSelection,
  inputTargetTabId,
  pasteFromClipboard,
  reflowActive,
  selectAll,
} from "./state/terminal";
import FullDiskAccessModal from "./components/FullDiskAccessModal.vue";
import HomeView from "./components/HomeView.vue";
import HostKeyMismatchModal from "./components/HostKeyMismatchModal.vue";
import TabBar from "./components/TabBar.vue";
import TerminalView from "./components/TerminalView.vue";
import TitleBar from "./components/TitleBar.vue";

const props = defineProps<{ config: Config }>();

const { tabs, active } = useTabs();
const hostKeyModal = ref<SshHostKeyMismatch | null>(null);
const fdaModal = ref(false);

const myLabel = currentWindowLabel();

function dismissFda(): void {
  // First-run only: once seen, never nag again on this machine.
  localStorage.setItem("prmpt.fdaOnboardingSeen", "1");
  fdaModal.value = false;
}

async function spawnNewTab(): Promise<void> {
  const { cellWidthPx, cellHeightPx, dpr } = getCellMetrics();
  const dims = computeDims();
  await spawnTerminal({
    cols: dims.cols,
    rows: dims.rows,
    cellWidthPx: Math.round(cellWidthPx * dpr),
    cellHeightPx: Math.round(cellHeightPx * dpr),
  });
  focusCanvas();
}

// The + button dragged over the terminal: spawn a fresh terminal and split it
// into the workspace at the drop point — same outcome as dragging an existing
// tab there, but the tab is born at the destination.
async function newTabIntoWorkspace(
  clientX: number,
  clientY: number,
): Promise<void> {
  // Resolve the drop target *before* spawning: spawnTerminal makes the new tab
  // active, which would make resolveDropAt point the split at the new tab
  // itself (and the self-drop guard would then cancel it). Mirrors
  // splitActive's capture-then-spawn-then-split ordering.
  const res = resolveDropAt(clientX, clientY);
  const { cellWidthPx, cellHeightPx, dpr } = getCellMetrics();
  const dims = computeDims();
  const newId = await spawnTerminal({
    cols: dims.cols,
    rows: dims.rows,
    cellWidthPx: Math.round(cellWidthPx * dpr),
    cellHeightPx: Math.round(cellHeightPx * dpr),
  });
  // No pane under the cursor → the freshly spawned tab just stays a normal
  // tab, a fine fallback.
  if (res) {
    dropTabIntoTarget(
      newId,
      res.slotId,
      res.targetPaneTabId,
      res.dir,
      res.placeDraggedFirst,
    );
  }
  focusCanvas();
}

// The + button dragged out of the window: spawn a terminal, then hand it to
// the same tear-off path tabs use (attach to a window under the cursor, or
// open a new window).
async function newTabInWindow(
  screenX: number,
  screenY: number,
): Promise<void> {
  const { cellWidthPx, cellHeightPx, dpr } = getCellMetrics();
  const dims = computeDims();
  const newId = await spawnTerminal({
    cols: dims.cols,
    rows: dims.rows,
    cellWidthPx: Math.round(cellWidthPx * dpr),
    cellHeightPx: Math.round(cellHeightPx * dpr),
  });
  await handleDragOut(newId, screenX, screenY);
}

async function handleDragOut(
  tabId: number,
  screenX: number,
  screenY: number,
): Promise<void> {
  // Cursor in CSS pixels (matches Tauri logical units). If it's over another
  // of our windows, attach to it; otherwise tear off into a new window sized
  // like the source. innerWidth/innerHeight rather than outer* — WKWebView
  // often reports zero for outer*, which would yield a 0x0 window.
  try {
    const target = await windowAtScreenPoint(screenX, screenY, myLabel);
    if (target) {
      await attachTab(tabId, target);
    } else {
      const width = Math.max(400, window.innerWidth);
      const height = Math.max(300, window.innerHeight);
      await tearOffTab({ tabId, screenX, screenY, width, height });
    }
    removeTabLocal(tabId);
    // Tearing off the last terminal closes the source window — same rule as
    // the exit path. Otherwise we'd leave an empty shell.
    const liveTerminals = tabs.value.filter((t) => t.kind !== "home");
    if (liveTerminals.length === 0) void closeCurrentWindow();
  } catch (err) {
    console.error("drag-out failed:", err);
  }
}

type EditableInput = HTMLInputElement | HTMLTextAreaElement;

function focusedEditable(): EditableInput | null {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement) {
    // Bail on inputs that don't carry editable text (checkbox/radio/buttons).
    const t = el.type;
    if (
      t === "text" ||
      t === "password" ||
      t === "search" ||
      t === "email" ||
      t === "url" ||
      t === "tel" ||
      t === "number"
    ) {
      return el;
    }
  }
  return null;
}

async function copyFromInput(el: EditableInput): Promise<void> {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  if (end <= start) return;
  // type=number / type=password don't expose selectionStart usefully — fall
  // back to the whole value if the range is empty but the field has text.
  const text = el.value.substring(start, end);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error("clipboard write failed:", err);
  }
}

async function pasteIntoInput(el: EditableInput): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch (err) {
    console.error("clipboard read failed:", err);
    return;
  }
  if (!text) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.substring(0, start) + text + el.value.substring(end);
  const cursor = start + text.length;
  try {
    el.setSelectionRange(cursor, cursor);
  } catch {
    /* type=number rejects setSelectionRange */
  }
  // Vue's v-model listens on `input`; without this dispatch the reactive
  // state would stay stale even though the DOM value updated.
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

type Shortcut = {
  mod: "meta" | "shift";
  match: (key: string) => boolean;
  when?: () => boolean;
  run: (e: KeyboardEvent) => void;
};

function scrollActive(
  kind: "line_up" | "line_down" | "page_up" | "page_down" | "top" | "bottom",
) {
  const target = inputTargetTabId();
  if (target != null) void scrollTab(target, { kind });
}

async function splitActive(dir: "h" | "v"): Promise<void> {
  const a = active.value;
  if (!a || a.kind === "home") return;
  const targetSlot = a.id;
  const targetPane = inputTargetTabId() ?? a.id;
  const { cellWidthPx, cellHeightPx, dpr } = getCellMetrics();
  const dims = computeDims();
  const newId = await spawnTerminal({
    cols: dims.cols,
    rows: dims.rows,
    cellWidthPx: Math.round(cellWidthPx * dpr),
    cellHeightPx: Math.round(cellHeightPx * dpr),
  });
  dropTabIntoTarget(newId, targetSlot, targetPane, dir, false);
  focusCanvas();
}

// WKWebView only fires `paste` when something editable is focused. The canvas
// isn't, so the global paste handler never sees Cmd+V via keyboard — we drive
// it from this table instead.
const shortcuts: Shortcut[] = [
  { mod: "meta", match: (k) => k === "t", run: () => void spawnNewTab() },
  {
    mod: "meta",
    match: (k) => k === "w",
    run: () => {
      const a = active.value;
      if (a) void closeTabAndForget(a.id);
    },
  },
  {
    mod: "meta",
    match: (k) => k === "d" || k === "D",
    run: (e) => void splitActive(e.shiftKey ? "v" : "h"),
  },
  {
    mod: "meta",
    match: (k) => /^[1-9]$/.test(k),
    run: (e) => {
      const idx = Number(e.key) - 1;
      const list = tabs.value.filter((t) => t.kind !== "home");
      if (list[idx]) setActive(list[idx].id);
    },
  },
  {
    mod: "meta",
    match: (k) => k === "c" || k === "C",
    when: () => hasSelection(),
    run: () => copyCurrentSelection(),
  },
  {
    mod: "meta",
    match: (k) => k === "v" || k === "V",
    run: () => void pasteFromClipboard(),
  },
  { mod: "meta", match: (k) => k === "a" || k === "A", run: () => selectAll() },
  {
    mod: "meta",
    match: (k) => k === "ArrowUp",
    run: () => scrollActive("line_up"),
  },
  {
    mod: "meta",
    match: (k) => k === "ArrowDown",
    run: () => scrollActive("line_down"),
  },
  { mod: "meta", match: (k) => k === "Home", run: () => scrollActive("top") },
  { mod: "meta", match: (k) => k === "End", run: () => scrollActive("bottom") },
  {
    mod: "shift",
    match: (k) => k === "PageUp",
    run: () => scrollActive("page_up"),
  },
  {
    mod: "shift",
    match: (k) => k === "PageDown",
    run: () => scrollActive("page_down"),
  },
];

function onKeyDown(e: KeyboardEvent) {
  // When focus is on a form input, don't hijack standard editing shortcuts
  // (a/c/v/x) for the terminal — let the field handle them natively (or
  // let the Edit menu accelerators route through the menu handlers).
  const editable = focusedEditable() != null;
  for (const s of shortcuts) {
    if (s.mod === "meta" && !e.metaKey) continue;
    if (s.mod === "shift" && !e.shiftKey) continue;
    if (!s.match(e.key)) continue;
    if (editable && s.mod === "meta" && /^[acvxACVX]$/.test(e.key)) continue;
    if (s.when && !s.when()) continue;
    e.preventDefault();
    s.run(e);
    return;
  }
  if (e.metaKey) return;

  const bytes = encodeKey(e);
  if (bytes) {
    const target = inputTargetTabId();
    if (target == null) return;
    e.preventDefault();
    clearSelection();
    void writeInput(target, bytes);
  }
}

function onPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData("text");
  if (!text) return;
  const target = inputTargetTabId();
  if (target == null) return;
  e.preventDefault();
  void writeInput(target, new TextEncoder().encode(text));
}

function onContextMenu(e: MouseEvent) {
  // Belt-and-suspenders: cancel WKWebView's default context menu app-wide.
  // Inside #terminal-host we also call showContextMenu(); outside it (e.g.
  // tab bar), a do-nothing preventDefault stops the system menu's Writing
  // Tools / Look Up / Autofill items from leaking through.
  e.preventDefault();
  const inTerm = (e.target as Element | null)?.closest?.("#terminal-host");
  if (inTerm) {
    void showContextMenu().catch((err) =>
      console.error("show_context_menu failed:", err),
    );
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("paste", onPaste);
  window.addEventListener("contextmenu", onContextMenu);

  await onRender((p) => {
    handleRender(p);
    applyTerminalBg(p.default_bg);
  });
  await onExit((p) => {
    handleExit(p);
    // Closing the last terminal closes the window. The home tab stays
    // resident, but a window with no live terminals has no reason to remain
    // (matches iTerm2 / Terminal.app behavior).
    const liveTerminals = tabs.value.filter((t) => t.kind !== "home");
    if (liveTerminals.length === 0) {
      closeCurrentWindow().catch((e) =>
        console.error("close window failed:", e),
      );
    }
  });
  await onTabAttached((p) => {
    attachTabLocal(p as TabHydrateInfo);
    // Resize newly-attached tabs to this window's geometry; their dims were
    // sized for the source window and likely no longer match.
    reflowActive(active.value);
  });
  await onMenuCopy(() => {
    const el = focusedEditable();
    if (el) void copyFromInput(el);
    else copyCurrentSelection();
  });
  await onMenuPaste(() => {
    const el = focusedEditable();
    if (el) void pasteIntoInput(el);
    else void pasteFromClipboard();
  });
  await onMenuSelectAll(() => {
    const el = focusedEditable();
    if (el) {
      try {
        el.select();
      } catch {
        /* some input types refuse select() */
      }
    } else {
      selectAll();
    }
  });
  await onSshHostKeyMismatch((p) => (hostKeyModal.value = p));
  await onSshHostKeyFirstConnect(async (p) => {
    try {
      await recordHostFingerprint(p.host_id, p.fingerprint, p.algorithm);
    } catch (err) {
      console.error("recordHostFingerprint failed:", err);
    }
  });
  await onSshPortForwardError((p) => {
    console.error(
      `[ssh] port-forward error tab=${p.tab_id} host=${p.host_id}: ${p.message}`,
    );
  });

  // Bootstrap: hydrate any tabs the backend has waiting for this window
  // (tear-off hand-off), or spawn a fresh terminal.
  const owned = await listTabsForWindow(myLabel);
  if (owned.length > 0) {
    hydrateTabs(owned);
    reflowActive(active.value);
    focusCanvas();
  } else {
    await spawnNewTab();
  }

  // First-run macOS Full Disk Access explainer: primary window only, once
  // per machine, and only if it isn't already granted. Off macOS the
  // backend reports granted=true so this never fires.
  if (myLabel === "main" && !localStorage.getItem("prmpt.fdaOnboardingSeen")) {
    try {
      if (!(await fullDiskAccessGranted())) fdaModal.value = true;
    } catch (err) {
      console.error("Full Disk Access check failed:", err);
    }
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("paste", onPaste);
  window.removeEventListener("contextmenu", onContextMenu);
});
</script>

<template>
  <TitleBar />
  <TabBar
    :on-drag-out="handleDragOut"
    @request-new-tab="spawnNewTab"
    @new-tab-workspace="newTabIntoWorkspace"
    @new-tab-window="newTabInWindow"
  />
  <TerminalView :config="props.config">
    <HomeView v-show="active?.kind === 'home'" />
  </TerminalView>
  <HostKeyMismatchModal
    v-if="hostKeyModal"
    :payload="hostKeyModal"
    @close="hostKeyModal = null"
  />
  <FullDiskAccessModal v-if="fdaModal" @close="dismissFda" />
</template>
