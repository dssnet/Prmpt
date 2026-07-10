<script setup lang="ts">
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onMounted, onBeforeUnmount, ref } from "vue";

import { isModifierKey, toWireKeyEvent } from "./input";
import {
  attachTab,
  bootstrapWindow,
  closeCurrentWindow,
  currentWindowLabel,
  onExit,
  onMenuCopy,
  onMenuPaste,
  onMenuSelectAll,
  onRender,
  onSshConnectError,
  onSshConnected,
  onSshHostKeyFirstConnect,
  onSshHostKeyMismatch,
  onSshPortForwardError,
  onSshReconnecting,
  onTabAttached,
  onTerminalNotification,
  onWindowActivateBlank,
  openNewWindow,
  scrollTab,
  tearOffTab,
  windowAtScreenPoint,
  writeKey,
  writePaste,
  type Config,
  type SshConnectError,
  type SshHostKeyFirstConnect,
  type SshHostKeyMismatch,
} from "./ipc";
import {
  attachTab as attachTabLocal,
  clearSshReconnecting,
  closeWorkspacePane,
  dropTabIntoTarget,
  firstTerminalLeafId,
  soleTerminalBackendId,
  handleExit,
  handleRender,
  HOME_TAB_ID,
  hydrateTabs,
  isSshReconnecting,
  isSshShellTab,
  isHostConnected,
  shellTabsForHost,
  owningTabId,
  removeTabLocal,
  setActive,
  setSshReconnecting,
  snapshotFor,
  spawnTerminal,
  openPanelOnActive,
  openPanelTab,
  useTabs,
  type TabHydrateInfo,
} from "./state/tabs";
import {
  applyTerminalBg,
  autoSplitDir,
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
import {
  copyFromInput,
  focusedEditable,
  pasteIntoInput,
  selectAllInInput,
} from "./lib/editable";
import { openInputContextMenu } from "./state/inputContextMenu";
import { openTerminalContextMenu } from "./state/terminalContextMenu";
import {
  cancelPendingClose,
  confirmPendingClose,
  pendingClose,
  pendingCloseTitle,
  requestCloseTab,
  windowCloseMessage,
} from "./state/closeGuard";
import { notify, notifyBell } from "./state/notifications";
import { startupView } from "./state/uiPrefs";
import {
  ACTIONS,
  bindingFor,
  canonicalKey,
  chordMatchesEvent,
  isPrimaryMod,
  IS_WIN,
} from "./state/keybindings";
import { openCommandPalette, paletteOpen } from "./state/commandPalette";
import { showToast } from "./state/toasts";
import CommandPalette from "./components/CommandPalette.vue";
import HomeView from "./components/HomeView.vue";
import HostKeyFirstConnectModal from "./components/HostKeyFirstConnectModal.vue";
import HostKeyMismatchModal from "./components/HostKeyMismatchModal.vue";
import PassphrasePromptModal from "./components/PassphrasePromptModal.vue";
import SshConnectErrorModal from "./components/SshConnectErrorModal.vue";
import UpdateModal from "./components/UpdateModal.vue";
import { passphrasePromptState } from "./state/passphrase-prompt";
import { runUpdateCheck } from "./state/update";
import { UPDATE_CHECK_INTERVAL_MS } from "./updater";
import { ConfirmDialog } from "./components/ui";
import TabBar from "./components/TabBar.vue";
import TerminalView from "./components/TerminalView.vue";
import TitleBar from "./components/TitleBar.vue";
import Toasts from "./components/Toasts.vue";
import FloatingMenu from "./components/FloatingMenu.vue";
import WelcomeOverlay from "./components/welcome/WelcomeOverlay.vue";

const props = defineProps<{ config: Config }>();

const { tabs, active } = useTabs();
const hostKeyModal = ref<SshHostKeyMismatch | null>(null);
const firstConnectModal = ref<SshHostKeyFirstConnect | null>(null);
const connectErrorModal = ref<SshConnectError | null>(null);

const myLabel = currentWindowLabel();

// First-boot welcome (hello → Full Disk Access → backup import): primary
// window only, once per machine. Initialized synchronously so the overlay
// is up on first paint, covering the terminal that boots underneath.
// Deliberately ignores the legacy prmpt.fdaOnboardingSeen flag — existing
// installs see the new welcome once too.
const welcomeOpen = ref(
  myLabel === "main" && !localStorage.getItem("prmpt.welcomeSeen"),
);

// Recurring background update check (in addition to the once-on-launch
// one). Cleared in onBeforeUnmount so tear-off windows don't leak timers.
let updateTimer: ReturnType<typeof setInterval> | undefined;

// Tauri event subscriptions installed in onMounted. Without unsubscribing
// on unmount, Vite HMR (which remounts App.vue on hot-reload) would stack
// duplicate handlers — one tear-off would then trigger N attachTabLocal +
// N spawnNewTab calls, polluting the new window with extra shells.
const unlisteners: UnlistenFn[] = [];

function dismissWelcome(): void {
  // Once seen, never again on this machine. (The import path never gets
  // here — useBackupImport sets the flag in beforeRelaunch instead.)
  localStorage.setItem("prmpt.welcomeSeen", "1");
  localStorage.removeItem("prmpt.fdaOnboardingSeen"); // legacy key cleanup
  welcomeOpen.value = false;
  // The launch update check was deferred while the welcome was up.
  void runUpdateCheck();
  // Hand focus to the terminal that booted underneath.
  focusCanvas();
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
    // Always boot a terminal so the window is never left empty. The
    // startup-view preference only decides what's *shown*: with "home", hand
    // the view to the always-present Home tab, leaving the fresh terminal
    // running in the background (a click on its tab picks it up).
    await spawnNewTab();
    if (startupView.value === "home") setActive(HOME_TAB_ID);
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
  // `tabId` is the frontend slot id; the backend tear-off/attach commands key
  // on the backend PTY id, which lives on the tab's sole terminal leaf
  // (TabBar only allows tearing off single-pane tabs; panel-only tabs have no
  // backend to move).
  const backendId = soleTerminalBackendId(tabId);
  if (backendId == null) return;
  // Cursor in CSS pixels (matches Tauri logical units). If it's over another
  // of our windows, attach to it; otherwise tear off into a new window sized
  // like the source. innerWidth/innerHeight rather than outer* — WKWebView
  // often reports zero for outer*, which would yield a 0x0 window.
  try {
    const target = await windowAtScreenPoint(screenX, screenY, myLabel);
    if (target) {
      await attachTab(backendId, target);
    } else {
      const width = Math.max(400, window.innerWidth);
      const height = Math.max(300, window.innerHeight);
      await tearOffTab({ tabId: backendId, screenX, screenY, width, height });
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

function scrollActive(
  kind: "line_up" | "line_down" | "page_up" | "page_down" | "top" | "bottom",
) {
  const target = inputTargetTabId();
  if (target != null) void scrollTab(target, { kind });
}

async function splitActive(dir: "h" | "v" | "auto"): Promise<void> {
  const a = active.value;
  if (!a || a.kind === "home") return;
  const targetSlot = a.id;
  // Focused pane, or the first terminal when a panel has focus (the slot id
  // is not a pane and can't anchor a split). A panel-only workspace has
  // neither — the fresh terminal then just stays its own tab.
  const targetPane = inputTargetTabId() ?? firstTerminalLeafId(a.id);
  // Resolve "auto" against the pane being split *before* spawning — the spawn
  // reshuffles focus, and the direction should reflect the pane's current shape.
  const resolvedDir =
    dir === "auto" ? (targetPane != null ? autoSplitDir(targetPane) : "h") : dir;
  const { cellWidthPx, cellHeightPx, dpr } = getCellMetrics();
  const dims = computeDims();
  const newId = await spawnTerminal({
    cols: dims.cols,
    rows: dims.rows,
    cellWidthPx: Math.round(cellWidthPx * dpr),
    cellHeightPx: Math.round(cellHeightPx * dpr),
  });
  if (targetPane != null) {
    dropTabIntoTarget(newId, targetSlot, targetPane, resolvedDir, false);
  }
  focusCanvas();
}

// What each bindable action *does*. The chords themselves (and any user
// overrides) live in state/keybindings.ts — this table only maps action id →
// behavior, plus the visibility guard that decides whether the action is live
// for the current tab. The keydown loop below resolves the live chord per
// action and dispatches here.
//
// The webview only fires `paste` when something editable is focused; the
// canvas isn't, so the paste chord (Cmd+V / Ctrl+Shift+V) never arrives as a
// `paste` event — `edit.paste` here is what drives it.
interface ActionHandler {
  when?: () => boolean;
  run: (e: KeyboardEvent) => void;
}
const isInteractiveTab = () => !!active.value && active.value.kind !== "home";
const actionHandlers: Record<string, ActionHandler> = {
  "palette.open": { run: () => openCommandPalette() },
  "tab.new": { run: () => void spawnNewTab() },
  "window.new": { run: () => void openNewWindow() },
  "tab.close": {
    run: () => {
      const a = active.value;
      if (a) void requestCloseTab(a);
    },
  },
  // Panel panes (see state/panels.ts): open a fresh, self-contained panel
  // seeded from the active tab's terminal (its cwd / server). On a plain tab
  // this converts it into a workspace in place.
  "layout.split.right": { when: isInteractiveTab, run: () => void splitActive("h") },
  "layout.split.down": { when: isInteractiveTab, run: () => void splitActive("v") },
  "layout.split.auto": { when: isInteractiveTab, run: () => void splitActive("auto") },
  "panel.files": { when: isInteractiveTab, run: () => void openPanelOnActive("files") },
  "panel.git": {
    when: () => active.value?.kind === "workspace",
    run: () => void openPanelOnActive("git"),
  },
  "scroll.lineUp": { run: () => scrollActive("line_up") },
  "scroll.lineDown": { run: () => scrollActive("line_down") },
  "scroll.top": { run: () => scrollActive("top") },
  "scroll.bottom": { run: () => scrollActive("bottom") },
  "scroll.pageUp": { run: () => scrollActive("page_up") },
  "scroll.pageDown": { run: () => scrollActive("page_down") },
  "edit.copy": { when: () => hasSelection(), run: () => copyCurrentSelection() },
  "edit.paste": { run: () => void pasteFromClipboard() },
  "edit.selectAll": { run: () => selectAll() },
};

function onKeyDown(e: KeyboardEvent) {
  // The command palette is a focused overlay that drives its own keyboard
  // (typing, arrows, Enter, Esc, Cmd+K to close) — never let App shortcuts or
  // PTY forwarding fire underneath it.
  if (paletteOpen.value) return;
  // While the welcome overlay is up, keep keystrokes and app shortcuts away
  // from the terminal booting underneath. No preventDefault — the welcome's
  // own inputs (backup passphrase) must keep native typing.
  if (welcomeOpen.value) return;
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
  // Bare Ctrl+C on a tab whose SSH session is mid-reconnect cancels the
  // reconnect by closing the tab (input is discarded during the backoff
  // anyway, so nothing else this key could mean). Sits after the Windows
  // copy-with-selection case so that still wins. A press that races a
  // just-succeeded reconnect (before "ssh:connected" reaches us) still
  // closes — millisecond window, accepted.
  if (!editable && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey
      && (key === "c" || key === "C")) {
    const target = inputTargetTabId();
    if (target != null && isSshReconnecting(target)) {
      e.preventDefault();
      // Close the reconnecting pane's backend; the exit event prunes its leaf
      // (closing the whole tab when it was the last pane).
      void closeWorkspacePane(target);
      return;
    }
  }
  // Cmd+1…9 / Ctrl+Shift+1…9 — switch to the Nth non-home tab. A numeric
  // family rather than a single rebindable chord (see "nav.switchNumber" in
  // the keybindings registry), so handled directly here.
  if (primary && /^[1-9]$/.test(key)) {
    e.preventDefault();
    const idx = Number(key) - 1;
    const list = tabs.value.filter((t) => t.kind !== "home");
    if (list[idx]) setActive(list[idx].id);
    return;
  }
  for (const a of ACTIONS) {
    if (a.info) continue;
    const chord = bindingFor(a.id);
    if (!chordMatchesEvent(chord, e)) continue;
    // Don't hijack native editing shortcuts (a/c/v/x) in a focused text field —
    // let it handle them, or the Edit-menu accelerators route through.
    if (editable && chord.primary && /^[acvx]$/.test(chord.key)) continue;
    const h = actionHandlers[a.id];
    if (!h) continue;
    if (h.when && !h.when()) continue;
    e.preventDefault();
    h.run(e);
    return;
  }
  // Swallow the primary chord even when nothing matched, so an unbound
  // Cmd/Ctrl+Shift combo never leaks to the terminal as a control byte.
  if (e.metaKey || primary) return;

  // Let focused text inputs (e.g. SFTP new-folder / rename fields) handle
  // their own keystrokes natively instead of forwarding them to the PTY.
  if (editable) return;

  const target = inputTargetTabId();
  if (target == null) return;
  // Bare modifier presses only produce bytes under the kitty keyboard
  // protocol — skip the IPC round-trip (and the preventDefault) otherwise.
  if (isModifierKey(e) && (snapshotFor(target)?.kitty_flags ?? 0) === 0) return;
  const wire = toWireKeyEvent(e, e.repeat ? "repeat" : "press");
  if (!wire) return;
  e.preventDefault();
  clearSelection();
  void writeKey(target, wire);
}

function onKeyUp(e: KeyboardEvent) {
  if (paletteOpen.value) return;
  if (welcomeOpen.value) return;
  if (focusedEditable(e.target) != null) return;
  if (e.metaKey || isPrimaryMod(e)) return;
  const target = inputTargetTabId();
  if (target == null) return;
  // Key releases only matter when the app asked for them (kitty
  // REPORT_EVENTS, bit 2) — the encoder discards them otherwise.
  if (((snapshotFor(target)?.kitty_flags ?? 0) & 2) === 0) return;
  const wire = toWireKeyEvent(e, "release");
  if (!wire) return;
  void writeKey(target, wire);
}

function onPaste(e: ClipboardEvent) {
  // Welcome overlay up: nothing here should reach the PTY underneath.
  if (welcomeOpen.value) return;
  // Let focused text inputs receive the paste natively (SFTP name fields, etc.).
  if (focusedEditable(e.target) != null) return;
  const text = e.clipboardData?.getData("text");
  if (!text) return;
  const target = inputTargetTabId();
  if (target == null) return;
  e.preventDefault();
  void writePaste(target, text);
}

// Capture-phase: editable text fields get their own Cut/Copy/Paste
// FloatingMenu everywhere in the app. Capture (not bubble) so it wins even
// inside panel panes and browser rows, which stop contextmenu propagation
// before the window-level bubble handler below would run.
function onEditableContextMenu(e: MouseEvent) {
  const el = focusedEditable(e.target);
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  openInputContextMenu(e, el);
}

function onContextMenu(e: MouseEvent) {
  // Belt-and-suspenders: cancel WKWebView's default context menu app-wide.
  // Inside #terminal-host we open our own FloatingMenu; outside it (e.g.
  // tab bar), a do-nothing preventDefault stops the system menu's Writing
  // Tools / Look Up / Autofill items from leaking through.
  e.preventDefault();
  const inTerm = (e.target as Element | null)?.closest?.("#terminal-host");
  if (inTerm) openTerminalContextMenu(e);
}

onMounted(async () => {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("paste", onPaste);
  window.addEventListener("contextmenu", onEditableContextMenu, true);
  window.addEventListener("contextmenu", onContextMenu);

  unlisteners.push(await onRender((p) => {
    handleRender(p);
    applyTerminalBg(p.default_bg);
  }));
  unlisteners.push(await onExit((p) => {
    // Was this an SSH tab/pane? If so, give the matching `ssh:connect_error`
    // event a moment to land before we consider closing the window — event
    // delivery order across the two channels (the direct `emit_to` and the
    // PTY → tab thread → exit chain) isn't guaranteed, and we don't want
    // to kill the window before the error modal mounts. (Checked via the
    // workspace tree too: an SSH tab with a files panel is a workspace.)
    const wasSsh = isSshShellTab(p.tab_id);
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
  unlisteners.push(await onWindowActivateBlank((p) => {
    // A window dragged out from a + menu option opens that panel as its sole
    // tab; the ordinary blank activation (dock-click / Cmd+N) spawns a shell.
    if (p.panel) {
      hasAdoptedTab = true; // don't let a later activate-blank pile a shell on top
      openPanelTab(p.panel);
      return;
    }
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
    if (el) selectAllInInput(el);
    else selectAll();
  }));
  // OSC notification (e.g. Claude Code finishing a task), routed through
  // the centralized dispatch: chime always (if enabled), toast + tab-bar
  // bell only when the user isn't looking at the originating tab. The
  // plain terminal BEL (tab autocomplete etc.) gets the lighter path:
  // blip + away-badge, no history entry.
  unlisteners.push(await onTerminalNotification((p) => {
    if (p.source === "bell") return notifyBell(p.tab_id);
    const t = tabs.value.find((x) => x.id === (owningTabId(p.tab_id) ?? p.tab_id));
    notify({
      tabId: p.tab_id,
      host: t?.hostLabel ?? "Local",
      title: p.title || "Notification",
      detail: p.body || t?.title || "A program requested attention",
    });
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
  // terminal; SFTP-only tabs have no visible VT, so toast instead. Shell tabs
  // (incl. workspace panes, where the find() misses) also arm the
  // Ctrl+C-cancels-reconnect shortcut — not SFTP-only tabs, where keyboard
  // focus lives in the file browser and Ctrl+C plausibly means "copy".
  unlisteners.push(await onSshReconnecting((p) => {
    // Reconnect is per pooled connection (keyed by host). Shell panes show the
    // in-terminal banner (and arm Ctrl+C-cancels-reconnect); a files-only host
    // has no VT, so surface it as a toast instead.
    const shellTabs = shellTabsForHost(p.host_id);
    if (shellTabs.length === 0) {
      if (isHostConnected(p.host_id)) {
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
    } else {
      shellTabs.forEach(setSshReconnecting);
    }
  }));
  unlisteners.push(await onSshConnected((p) => {
    shellTabsForHost(p.host_id).forEach(clearSshReconnecting);
  }));

  // Confirm-on-close guard for the whole window (traffic light, custom
  // TitleBar button, OS chrome — every path lands here). Tauri awaits this
  // async handler before deciding: unless preventDefault() was called, the
  // window is destroyed. Confirming the dialog destroys explicitly (destroy
  // skips CloseRequested, so no re-entry). Empty/reserve windows are never
  // busy and close straight through.
  unlisteners.push(await getCurrentWebviewWindow().onCloseRequested(async (ev) => {
    try {
      const msg = await windowCloseMessage();
      if (msg) {
        ev.preventDefault();
        pendingClose.value = { kind: "window", message: msg };
      }
    } catch (err) {
      // On any guard failure, let the close proceed — never wedge the window.
      console.error("close guard failed:", err);
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
      // Startup-view preference: the prespawned launch terminal (forked on the
      // backend before this frontend booted) stays live in the background, but
      // "home" lands the view on the Home tab instead of the terminal.
      if (startupView.value === "home") setActive(HOME_TAB_ID);
      else focusCanvas();
    } else {
      await autoSpawnInitialTab();
    }
  }
  // mode === "reserve": stay idle. onTabAttached + onWindowActivateBlank
  // (installed above) handle whichever activation fires.

  // Updater: silent check on launch, then on a recurring interval.
  // Only the primary window drives this — a relaunch tears down every
  // window, so multiple windows racing the same check is pointless.
  // Kept off the critical path (no await) so first paint never waits on
  // the network. While the welcome overlay is up the launch check is
  // deferred to dismissWelcome() so UpdateModal can't pop over it.
  if (myLabel === "main") {
    if (!welcomeOpen.value) void runUpdateCheck();
    updateTimer = setInterval(() => {
      void runUpdateCheck();
    }, UPDATE_CHECK_INTERVAL_MS);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
  window.removeEventListener("paste", onPaste);
  window.removeEventListener("contextmenu", onEditableContextMenu, true);
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
  <WelcomeOverlay v-if="welcomeOpen" @close="dismissWelcome" />
  <PassphrasePromptModal
    v-if="passphrasePromptState"
    :state="passphrasePromptState"
  />
  <SshConnectErrorModal
    v-if="connectErrorModal"
    :payload="connectErrorModal"
    @close="dismissConnectError"
  />
  <ConfirmDialog
    :open="!!pendingClose"
    :title="pendingClose ? pendingCloseTitle(pendingClose.kind) : ''"
    :message="pendingClose?.message"
    confirm-label="Close"
    tone="danger"
    @confirm="confirmPendingClose"
    @cancel="cancelPendingClose"
  />
  <UpdateModal />
  <Toasts />
  <FloatingMenu />
  <CommandPalette />
</template>
