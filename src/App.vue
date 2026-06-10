<script setup lang="ts">
import { readText as readClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onMounted, onBeforeUnmount, ref } from "vue";

import { encodeKey } from "./input";
import {
  attachTab,
  bootstrapWindow,
  closeCurrentWindow,
  currentWindowLabel,
  fullDiskAccessGranted,
  onExit,
  onMenuCopy,
  onMenuPaste,
  onMenuSelectAll,
  onRender,
  onSshConnectError,
  onSshHostKeyFirstConnect,
  onSshHostKeyMismatch,
  onSshPortForwardError,
  onSshReconnecting,
  onTabAttached,
  onWindowActivateBlank,
  openNewWindow,
  scrollTab,
  showContextMenu,
  tearOffTab,
  windowAtScreenPoint,
  writeInput,
  type Config,
  type SshConnectError,
  type SshHostKeyFirstConnect,
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
import { toggleLocalBrowser } from "./state/localBrowser";
import { showToast } from "./state/toasts";
import FullDiskAccessModal from "./components/FullDiskAccessModal.vue";
import HomeView from "./components/HomeView.vue";
import HostKeyFirstConnectModal from "./components/HostKeyFirstConnectModal.vue";
import HostKeyMismatchModal from "./components/HostKeyMismatchModal.vue";
import PassphrasePromptModal from "./components/PassphrasePromptModal.vue";
import SshConnectErrorModal from "./components/SshConnectErrorModal.vue";
import UpdateModal from "./components/UpdateModal.vue";
import { passphrasePromptState } from "./state/passphrase-prompt";
import { runUpdateCheck } from "./state/update";
import { UPDATE_CHECK_INTERVAL_MS } from "./updater";
import TabBar from "./components/TabBar.vue";
import TerminalView from "./components/TerminalView.vue";
import TitleBar from "./components/TitleBar.vue";
import Toasts from "./components/Toasts.vue";

const props = defineProps<{ config: Config }>();

const { tabs, active } = useTabs();
const hostKeyModal = ref<SshHostKeyMismatch | null>(null);
const firstConnectModal = ref<SshHostKeyFirstConnect | null>(null);
const connectErrorModal = ref<SshConnectError | null>(null);
const fdaModal = ref(false);

const myLabel = currentWindowLabel();

// Recurring background update check (in addition to the once-on-launch
// one). Cleared in onBeforeUnmount so tear-off windows don't leak timers.
let updateTimer: ReturnType<typeof setInterval> | undefined;

// Tauri event subscriptions installed in onMounted. Without unsubscribing
// on unmount, Vite HMR (which remounts App.vue on hot-reload) would stack
// duplicate handlers — one tear-off would then trigger N attachTabLocal +
// N spawnNewTab calls, polluting the new window with extra shells.
const unlisteners: UnlistenFn[] = [];

function dismissFda(): void {
  // First-run only: once seen, never nag again on this machine.
  localStorage.setItem("prmpt.fdaOnboardingSeen", "1");
  fdaModal.value = false;
}

function dismissConnectError(): void {
  connectErrorModal.value = null;
  // The window-close-on-empty branch in `onExit` skipped its close while
  // this modal was open. Re-run that check now so the window doesn't sit
  // empty after the user dismisses the error.
  const liveTerminals = tabs.value.filter((t) => t.kind !== "home");
  if (liveTerminals.length === 0) {
    closeCurrentWindow().catch((e) =>
      console.error("close window failed:", e),
    );
  }
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

// Auto-spawn an initial terminal only if this window has none yet. Guards
// the bootstrap empty-Normal and activate-blank paths against double-firing
// (Vite HMR remounting App.vue stacks listeners; a tear-off racing past
// activate-blank could otherwise pile a fresh shell on top of the attached
// torn-off tab).
//
// The `hasAdoptedTab` flag is sticky: once a tab has been attached via the
// onTabAttached path (tear-off into this window), the activate-blank
// listener must NEVER spawn an extra shell on top, even if it fires later
// due to a stale handler or replay. The in-flight flag covers the rapid
// double-fire case where the synchronous `tabs.value.some` guard is read
// twice before either `await spawnTerminal` completes.
let hasAdoptedTab = false;
let autoSpawnInFlight = false;

async function autoSpawnInitialTab(): Promise<void> {
  if (hasAdoptedTab || autoSpawnInFlight) return;
  if (tabs.value.some((t) => t.kind !== "home")) return;
  autoSpawnInFlight = true;
  try {
    await spawnNewTab();
  } finally {
    autoSpawnInFlight = false;
  }
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

// Resolve an editable text field from a candidate element. Pass an event's
// `target` to test where a keystroke *originated* rather than the live
// `document.activeElement`: an input's own Enter handler may tear itself down
// (navigate / close) before the event bubbles to the window listener, leaving
// `activeElement` on <body> — so a target-blind check would wrongly forward the
// Enter to the PTY. Defaults to `activeElement` when no candidate is given.
function focusedEditable(candidate?: EventTarget | null): EditableInput | null {
  const el = (candidate as Element | null) ?? document.activeElement;
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
    text = await readClipboardText();
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

// macOS uses Cmd (metaKey) as the app modifier; Linux/Windows terminals use
// Ctrl+Shift so plain Ctrl stays free for shell control codes (Ctrl+C =
// SIGINT, Ctrl+D = EOF, …). Matches GNOME Terminal / Konsole / Windows
// Terminal conventions.
const IS_MAC =
  /Mac|iPhone|iPod|iPad/.test(navigator.platform) ||
  navigator.userAgent.includes("Mac OS X");
const IS_WIN = !IS_MAC && /Win/i.test(navigator.platform);

// True when the platform's primary app-shortcut chord is held.
function isPrimaryMod(e: KeyboardEvent): boolean {
  return IS_MAC
    ? e.metaKey && !e.ctrlKey
    : e.ctrlKey && e.shiftKey && !e.metaKey;
}

// Layout/Shift-stable key name: physical letter/digit via `code` (so
// Ctrl+Shift+C still reads as "c" and Ctrl+Shift+1 as "1"), otherwise the
// logical key ("ArrowUp", "Home", …).
function canonicalKey(e: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (e.key.length === 1) return e.key.toLowerCase();
  return e.key;
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

// The webview only fires `paste` when something editable is focused. The
// canvas isn't, so the global paste handler never sees the paste chord
// (Cmd+V / Ctrl+Shift+V) via keyboard — we drive it from this table instead.
const shortcuts: Shortcut[] = [
  { mod: "meta", match: (k) => k === "t", run: () => void spawnNewTab() },
  { mod: "meta", match: (k) => k === "n", run: () => void openNewWindow() },
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
      const idx = Number(canonicalKey(e)) - 1;
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
    match: (k) => k === "b" || k === "B",
    when: () => active.value?.kind === "terminal",
    run: () => {
      const a = active.value;
      if (a) toggleLocalBrowser(a.id);
    },
  },
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
  const editable = focusedEditable(e.target) != null;
  const key = canonicalKey(e);
  const primary = isPrimaryMod(e);
  // Windows Terminal convention: bare Ctrl+C copies when there's a
  // selection (falls through to SIGINT otherwise), bare Ctrl+V pastes.
  // The menu owns Ctrl+Shift+C/V on Windows (see install_app_menu).
  if (IS_WIN && !editable && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
    if ((key === "c" || key === "C") && hasSelection()) {
      e.preventDefault();
      copyCurrentSelection();
      return;
    }
    if (key === "v" || key === "V") {
      e.preventDefault();
      void pasteFromClipboard();
      return;
    }
  }
  for (const s of shortcuts) {
    if (s.mod === "meta" && !primary) continue;
    if (s.mod === "shift" && !(e.shiftKey && !primary)) continue;
    if (!s.match(key)) continue;
    if (editable && s.mod === "meta" && /^[acvx]$/.test(key)) continue;
    if (s.when && !s.when()) continue;
    e.preventDefault();
    s.run(e);
    return;
  }
  // Swallow the primary chord even when nothing matched, so an unbound
  // Cmd/Ctrl+Shift combo never leaks to the terminal as a control byte.
  if (e.metaKey || primary) return;

  // Let focused text inputs (e.g. SFTP new-folder / rename fields) handle
  // their own keystrokes natively instead of forwarding them to the PTY.
  if (editable) return;

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
  // Let focused text inputs receive the paste natively (SFTP name fields, etc.).
  if (focusedEditable(e.target) != null) return;
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

  unlisteners.push(await onRender((p) => {
    handleRender(p);
    applyTerminalBg(p.default_bg);
  }));
  unlisteners.push(await onExit((p) => {
    // Was this an SSH tab? If so, give the matching `ssh:connect_error`
    // event a moment to land before we consider closing the window — event
    // delivery order across the two channels (the direct `emit_to` and the
    // PTY → tab thread → exit chain) isn't guaranteed, and we don't want
    // to kill the window before the error modal mounts.
    const wasSsh = tabs.value.find((t) => t.id === p.tab_id)?.kind === "ssh";
    handleExit(p);
    const maybeCloseWindow = () => {
      const liveTerminals = tabs.value.filter((t) => t.kind !== "home");
      if (liveTerminals.length === 0 && !connectErrorModal.value) {
        closeCurrentWindow().catch((e) =>
          console.error("close window failed:", e),
        );
      }
    };
    if (wasSsh) window.setTimeout(maybeCloseWindow, 200);
    else maybeCloseWindow();
  }));
  unlisteners.push(await onTabAttached((p) => {
    // Sticky: once a tab was attached here, never let a stray
    // activate-blank fire spawn an extra shell on top.
    hasAdoptedTab = true;
    attachTabLocal(p as TabHydrateInfo);
    // Resize newly-attached tabs to this window's geometry; their dims were
    // sized for the source window and likely no longer match.
    reflowActive(active.value);
  }));
  // Activation for a previously-reserve window: spawn the first tab now
  // that the user has actually claimed this webview. Must be installed
  // before bootstrapWindow returns so a pop_for_blank firing immediately
  // after bootstrap can't race past the listener registration.
  unlisteners.push(await onWindowActivateBlank(() => {
    void autoSpawnInitialTab();
  }));
  unlisteners.push(await onMenuCopy(() => {
    const el = focusedEditable();
    if (el) void copyFromInput(el);
    else copyCurrentSelection();
  }));
  unlisteners.push(await onMenuPaste(() => {
    const el = focusedEditable();
    if (el) void pasteIntoInput(el);
    else void pasteFromClipboard();
  }));
  unlisteners.push(await onMenuSelectAll(() => {
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
  }));
  unlisteners.push(await onSshHostKeyMismatch((p) => (hostKeyModal.value = p)));
  // The SSH handshake is parked in the backend until the modal answers.
  unlisteners.push(await onSshHostKeyFirstConnect((p) => (firstConnectModal.value = p)));
  unlisteners.push(await onSshPortForwardError((p) => {
    console.error(
      `[ssh] port-forward error tab=${p.tab_id} host=${p.host_id}: ${p.message}`,
    );
  }));
  unlisteners.push(await onSshConnectError((p) => {
    connectErrorModal.value = p;
  }));
  // Shell tabs surface "connection lost — reconnecting…" as a banner in the
  // terminal; SFTP-only tabs have no visible VT, so toast instead.
  unlisteners.push(await onSshReconnecting((p) => {
    const t = tabs.value.find((t) => t.id === p.tab_id);
    if (t?.kind === "ssh" && t.disableSsh) {
      showToast(
        {
          host: p.host_label,
          title: "Connection lost",
          detail: "Reconnecting…",
          kind: "error",
        },
        8000,
      );
    }
  }));

  // Bootstrap: ask the backend whether this window is a pre-warmed
  // reserve (sit idle until activation) or a normal window (hydrate
  // tabs or spawn a fresh one). Invoking bootstrapWindow is also what
  // marks a reserve `Ready` on the backend, so it's safe to be popped
  // for the next activation after this call returns.
  const boot = await bootstrapWindow(myLabel);
  if (boot.mode === "normal") {
    if (boot.tabs.length > 0) {
      hydrateTabs(boot.tabs);
      reflowActive(active.value);
      focusCanvas();
    } else {
      await autoSpawnInitialTab();
    }
  }
  // mode === "reserve": stay idle. onTabAttached + onWindowActivateBlank
  // (installed above) handle whichever activation fires.

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

  // Updater: silent check on launch, then on a recurring interval.
  // Only the primary window drives this — a relaunch tears down every
  // window, so multiple windows racing the same check is pointless.
  // Kept off the critical path (no await) so first paint never waits on
  // the network.
  if (myLabel === "main") {
    void runUpdateCheck();
    updateTimer = setInterval(() => {
      void runUpdateCheck();
    }, UPDATE_CHECK_INTERVAL_MS);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("paste", onPaste);
  window.removeEventListener("contextmenu", onContextMenu);
  if (updateTimer !== undefined) clearInterval(updateTimer);
  for (const fn of unlisteners) {
    try {
      fn();
    } catch (e) {
      console.error("unlisten failed:", e);
    }
  }
  unlisteners.length = 0;
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
  <HostKeyFirstConnectModal
    v-if="firstConnectModal"
    :payload="firstConnectModal"
    @close="firstConnectModal = null"
  />
  <FullDiskAccessModal v-if="fdaModal" @close="dismissFda" />
  <PassphrasePromptModal
    v-if="passphrasePromptState"
    :state="passphrasePromptState"
  />
  <SshConnectErrorModal
    v-if="connectErrorModal"
    :payload="connectErrorModal"
    @close="dismissConnectError"
  />
  <UpdateModal />
  <Toasts />
</template>
