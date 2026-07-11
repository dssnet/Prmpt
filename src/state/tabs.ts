import { computed, ref } from "vue";

import {
  closeTab,
  connectSshHost,
  forgetTab,
  spawnTab,
  terminalCwd,
  type ExitPayload,
  type RenderPayload,
} from "../ipc";
import {
  collectLeaves,
  collectTerminalLeaves,
  deleteWorkspace,
  findLeafByTabId,
  getWorkspace,
  isPanelLeaf,
  makeLeaf,
  makeSplit,
  removeLeaf,
  setWorkspace,
  splitLeaf,
  workspaceOfLeaf,
  type LeafNode,
  type SplitDir,
  type WorkspaceNode,
} from "./workspace";
import {
  allocPanelLeafId,
  panelTitle,
  PANEL_SPLIT_RATIO,
  type PanelDesc,
  type PanelKind,
} from "./panels";
import { setSftpAutoOpen, sftpAutoOpen } from "./sftp";
import { paneSftpHost, releaseSftpForPane } from "./sftpConsumers";

export const HOME_TAB_ID = 0;

// Every non-home tab is a workspace of panes (a one-pane workspace renders
// full-bleed — see terminal.ts). Terminals and frontend panels (files/git) are
// both just panes; a terminal is special only in that the shared canvas draws
// its body. The connection metadata below rides on the workspace tab when the
// tab hosts an SSH connection.
//
// Identity: a tab's id (the "slot id") is a frontend-allocated synthetic id
// (negative, from the shared `allocPanelLeafId` counter) — it never names a
// backend PTY. Backend tab ids live only on workspace *leaves*; translate with
// `workspaceOfLeaf` / `owningTabId`. (One exception: an SFTP-only workspace's
// pooled ssh connection is registered on the backend under its negative slot
// id, so its exit arrives addressed to the slot — see `handleExit`.)
export type TabKind = "home" | "workspace";

export interface TabState {
  id: number;
  kind: TabKind;
  title: string;
  hostLabel?: string;
  hostId?: number;
  /** SSH connections only: the host opted out of SFTP (lazy/no file browser). */
  disableSftp?: boolean;
}

export interface TabHydrateInfo {
  id: number;
  kind?: "terminal" | "ssh";
  host_id?: number | null;
  host_label?: string | null;
  disable_sftp?: boolean;
  disable_ssh?: boolean;
}

// Reactive state. The tabs array drives the tab bar; activeId picks the focused
// one. Snapshots (huge per-frame cell arrays) live outside the reactive tree —
// proxying them per frame would be a perf disaster — and a separate counter
// triggers re-renders whenever a snapshot arrives for the active tab.
const tabs = ref<TabState[]>([
  { id: HOME_TAB_ID, kind: "home", title: "Home" },
]);
const activeId = ref<number>(HOME_TAB_ID);
const snapshots = new Map<number, RenderPayload>();
const renderSeq = ref(0);

// Backend tab ids whose SSH session is currently down and auto-reconnecting
// (set on "ssh:reconnecting", cleared on "ssh:connected" / exit). Keyed by
// tab id rather than TabState because workspace panes have no TabState; only
// read imperatively by the Ctrl+C-cancels-reconnect check, so not reactive.
const sshReconnecting = new Set<number>();

export function setSshReconnecting(id: number): void {
  sshReconnecting.add(id);
}

export function clearSshReconnecting(id: number): void {
  sshReconnecting.delete(id);
}

export function isSshReconnecting(id: number): boolean {
  return sshReconnecting.has(id);
}

export function useTabs() {
  const list = computed(() => tabs.value);
  const terminals = computed(() =>
    tabs.value.filter((t) => t.kind === "workspace"),
  );
  const active = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? null);
  const activeTitle = computed(() => active.value?.title ?? "Prmpt");

  return {
    tabs: list,
    terminals,
    active,
    activeId,
    activeTitle,
    renderSeq,
  };
}

export function isInteractiveTab(t: TabState | null | undefined): boolean {
  return !!t && t.kind !== "home";
}

/** Host ids with a live SSH presence in this window: a shell terminal leaf, or
 *  a files-panel leaf bound to a host's SFTP consumer. Deduped by host (a shell
 *  and its files panel on the same host share one pooled connection). Used by
 *  the close-guard count and reconnect/identity checks. Read inside a computed
 *  that also touches `workspaceTick` for reactivity to pane changes. */
export function openSshHostIds(): Set<number> {
  const ids = new Set<number>();
  for (const t of tabs.value) {
    if (t.kind !== "workspace") continue;
    const ws = getWorkspace(t.id);
    if (!ws) continue;
    for (const leaf of collectLeaves(ws.root)) {
      if (leaf.origin.kind === "ssh" && leaf.origin.hostId != null) {
        ids.add(leaf.origin.hostId);
      } else if (isPanelLeaf(leaf)) {
        const h = paneSftpHost(leaf.tabId);
        if (h != null) ids.add(h);
      }
    }
  }
  return ids;
}

/** Shell terminal-pane tab ids for `hostId` in this window. Empty when the
 *  host has no shell pane (files-only) — reconnect then surfaces as a toast
 *  rather than an in-terminal banner. */
export function shellTabsForHost(hostId: number): number[] {
  const out: number[] = [];
  for (const t of tabs.value) {
    if (t.kind !== "workspace") continue;
    const ws = getWorkspace(t.id);
    if (!ws) continue;
    for (const leaf of collectLeaves(ws.root)) {
      if (leaf.origin.kind === "ssh" && leaf.origin.hostId === hostId) {
        out.push(leaf.tabId);
      }
    }
  }
  return out;
}

/** True if `hostId` has any live SSH presence (shell or files consumer) here. */
export function isHostConnected(hostId: number): boolean {
  return openSshHostIds().has(hostId);
}

/** True if `tabId` is a live SSH shell terminal pane in this window. */
export function isSshShellTab(tabId: number): boolean {
  for (const t of tabs.value) {
    if (t.kind !== "workspace") continue;
    const ws = getWorkspace(t.id);
    if (!ws) continue;
    for (const leaf of collectLeaves(ws.root)) {
      if (leaf.origin.kind === "ssh" && leaf.tabId === tabId) return true;
    }
  }
  return false;
}

/** The top-level tab hosting `tabId`: itself for standalone tabs, or the
 *  workspace slot that contains it as a pane. Null if it isn't open. */
export function owningTabId(tabId: number): number | null {
  for (const t of tabs.value) {
    if (t.id === tabId) return t.id;
    if (t.kind === "workspace") {
      const ws = getWorkspace(t.id);
      if (ws && collectLeaves(ws.root).some((l) => l.tabId === tabId)) return t.id;
    }
  }
  return null;
}

export function isWorkspaceTab(t: TabState | null | undefined): boolean {
  return !!t && t.kind === "workspace";
}

/** The backend id of a single-pane tab's terminal leaf, or null when the tab
 *  is multi-pane or panel-only. Tear-off moves exactly one backend tab across
 *  windows, so this is the id `tear_off_tab` / `attach_tab` need. */
export function soleTerminalBackendId(slotId: number): number | null {
  const ws = getWorkspace(slotId);
  if (!ws) return null;
  const leaves = collectLeaves(ws.root);
  if (leaves.length !== 1 || isPanelLeaf(leaves[0])) return null;
  return leaves[0].tabId;
}

/** First terminal leaf of a tab — the anchor/cwd fallback when the focused
 *  pane is a panel (`inputTargetTabId()` returns null there). Null for
 *  panel-only workspaces. */
export function firstTerminalLeafId(slotId: number): number | null {
  const ws = getWorkspace(slotId);
  if (!ws) return null;
  return collectTerminalLeaves(ws.root)[0]?.tabId ?? null;
}

function findTab(id: number): TabState | undefined {
  return tabs.value.find((t) => t.id === id);
}

function spliceTab(id: number): void {
  const idx = tabs.value.findIndex((t) => t.id === id);
  if (idx >= 0) tabs.value.splice(idx, 1);
}

function pickActiveAfterRemoval(): number {
  const next = tabs.value.find((t) => t.kind !== "home");
  return next ? next.id : HOME_TAB_ID;
}

export function snapshotFor(tabId: number): RenderPayload | undefined {
  return snapshots.get(tabId);
}

export function activeSnapshot(): RenderPayload | undefined {
  return snapshots.get(activeId.value);
}

/** Build the initial workspace tree for a freshly-connected tab. `base` is the
 *  tab's primary pane — a terminal leaf, or a files panel for an SFTP-only
 *  connection. A shell SSH connection auto-opens a files panel beside it
 *  (unless opted out / the user last closed it). Every tab is a workspace; a
 *  one-pane workspace just renders full-bleed (see terminal.ts). */
function seedWorkspace(t: TabState, base: LeafNode): void {
  let root: WorkspaceNode = base;
  // Auto-open a files panel beside a *shell* connection (a terminal base) when
  // the host offers SFTP and the user hasn't opted out. A files-only base
  // (SFTP-only host) is already the file browser, so nothing to add.
  if (
    !isPanelLeaf(base) &&
    t.hostId != null &&
    !t.disableSftp &&
    sftpAutoOpen()
  ) {
    root = makeSplit(
      "h",
      base,
      makePanelLeaf({
        kind: "files",
        seedHostId: t.hostId,
        seedTargetTabId: base.tabId,
      }),
      PANEL_SPLIT_RATIO.files,
    );
  }
  setWorkspace(t.id, { root, focusedTabId: base.tabId });
}

/** Returns the new tab's slot id (a frontend id — the backend PTY id lives
 *  on the workspace leaf). */
export async function spawnTerminal(args: {
  cols: number;
  rows: number;
  cellWidthPx: number;
  cellHeightPx: number;
  /** Optional initial working directory (e.g. "same folder" spawns). */
  cwd?: string;
}): Promise<number> {
  const backendId = await spawnTab(args);
  const t: TabState = { id: allocPanelLeafId(), kind: "workspace", title: "Terminal" };
  tabs.value.push(t);
  seedWorkspace(t, makeLeaf(backendId, { kind: "terminal", title: "Terminal" }));
  activeId.value = t.id;
  return t.id;
}

/** Returns the new tab's slot id (like `spawnTerminal`). */
export async function spawnSsh(args: {
  hostId: number;
  hostLabel: string;
  cols: number;
  rows: number;
  cellWidthPx: number;
  cellHeightPx: number;
  config: import("../ipc").SshConnectConfig;
}): Promise<number> {
  const backendId = await connectSshHost({
    config: args.config,
    cols: args.cols,
    rows: args.rows,
    cellWidthPx: args.cellWidthPx,
    cellHeightPx: args.cellHeightPx,
  });
  const t: TabState = {
    id: allocPanelLeafId(),
    kind: "workspace",
    title: args.hostLabel,
    hostLabel: args.hostLabel,
    hostId: args.hostId,
    disableSftp: args.config.disable_sftp,
  };
  tabs.value.push(t);
  seedWorkspace(t, sshTerminalLeaf(t, backendId));
  activeId.value = t.id;
  return t.id;
}

/** The shell terminal leaf for an SSH connection workspace (owns its PTY). */
function sshTerminalLeaf(t: TabState, backendId: number): LeafNode {
  return makeLeaf(backendId, {
    kind: "ssh",
    title: t.title,
    hostLabel: t.hostLabel,
    hostId: t.hostId,
    disableSftp: t.disableSftp,
  });
}

/** Open a files-only workspace for an SFTP-only host (no shell). The workspace
 *  has no backend tab; its single files panel acquires/releases the host's
 *  SFTP consumer over the pane's lifetime. The slot id is a frontend-allocated
 *  negative id (like a panel leaf). */
export function openSftpOnlyHost(hostId: number, label: string): void {
  const slotId = allocPanelLeafId();
  const t: TabState = {
    id: slotId,
    kind: "workspace",
    title: label,
    hostLabel: label,
    hostId,
  };
  tabs.value.push(t);
  const leaf = makePanelLeaf({
    kind: "files",
    seedHostId: hostId,
    seedPath: undefined,
  });
  setWorkspace(slotId, { root: leaf, focusedTabId: leaf.tabId });
  activeId.value = slotId;
}

/** Open a panel (file browser / git) as its own tab in the tab bar — a
 *  panel-only workspace with no terminal pane, like `openSftpOnlyHost` but for
 *  local-seeded panels. The single panel pane is self-contained (it picks its
 *  own source/folder); closing it collapses the whole tab. `desc`/`title`
 *  carry a moved panel's seeds + live title (cross-window drops); a fresh
 *  panel passes just `{ kind }`. Returns the new tab's slot id. */
export function openPanelTab(desc: PanelDesc, title?: string): number {
  const slotId = allocPanelLeafId();
  const leaf = makePanelLeaf(desc, title);
  const t: TabState = {
    id: slotId,
    kind: "workspace",
    title: leaf.origin.title,
  };
  tabs.value.push(t);
  setWorkspace(slotId, { root: leaf, focusedTabId: leaf.tabId });
  activeId.value = slotId;
  return slotId;
}

/** Register a fully-built workspace tree (its backends already spawned) as a
 *  new tab and focus it. Used by the saved-workspace load path
 *  (`state/connect.ts::loadSavedWorkspace`), which respawns the panes before
 *  handing the tree here. The slot id is a fresh frontend id (like
 *  `openPanelTab` / `openSftpOnlyHost`) — independent of the pane backends, so
 *  a multi-pane restore needs no primary-pane bookkeeping. Returns the slot id. */
export function addRestoredWorkspace(
  label: string,
  root: WorkspaceNode,
  focusedTabId: number,
): number {
  const slotId = allocPanelLeafId();
  const t: TabState = { id: slotId, kind: "workspace", title: label };
  tabs.value.push(t);
  setWorkspace(slotId, { root, focusedTabId });
  activeId.value = slotId;
  return slotId;
}

export async function closeTabAndForget(id: number): Promise<void> {
  if (id === HOME_TAB_ID) return;
  const t = findTab(id);
  if (t && t.kind === "workspace") {
    const ws = getWorkspace(id);
    deleteWorkspace(id);
    spliceTab(id);
    if (activeId.value === id) activeId.value = pickActiveAfterRemoval();
    if (ws) {
      for (const leaf of collectLeaves(ws.root)) {
        snapshots.delete(leaf.tabId);
        if (!isPanelLeaf(leaf)) {
          // Terminal pane → close its PTY (or release its pooled shell).
          closeTab(leaf.tabId).catch(() => undefined);
        } else if (leaf.origin.panel?.kind === "files") {
          // File browser → release its SFTP consumer (drops the pooled
          // connection when it was the last consumer).
          releaseSftpForPane(leaf.tabId);
        }
      }
    }
    return;
  }
  try {
    await closeTab(id);
  } catch {
    /* ignore — exit event still cleans up */
  }
}

/** Splice a tab out of the bar and drop its (now-empty) workspace, without
 *  touching the backend — its pane has been grafted into another workspace. */
function consumeTabIntoWorkspace(id: number): void {
  deleteWorkspace(id);
  spliceTab(id);
}

/** Drop `draggedTabId` (a whole tab) onto a pane in the target workspace,
 *  splitting the hit pane. Both are workspaces now; the dragged tab's whole
 *  tree — single pane or multi-pane — is grafted in as a subtree and its tab
 *  removed. Node/pane ids are globally unique, so the subtree moves as-is and
 *  panel panes keep their state (keyed by pane id). Returns the target slot
 *  id, or null if the drop was a no-op. */
export function dropTabIntoTarget(
  draggedTabId: number,
  targetSlotId: number,
  targetPaneTabId: number,
  dir: SplitDir,
  placeDraggedFirst: boolean,
): number | null {
  if (draggedTabId === targetPaneTabId || draggedTabId === targetSlotId) return null;
  const dragged = findTab(draggedTabId);
  const target = findTab(targetSlotId);
  if (!dragged || !target || dragged.kind !== "workspace" || target.kind !== "workspace") {
    return null;
  }
  const dws = getWorkspace(draggedTabId);
  const tws = getWorkspace(targetSlotId);
  if (!dws || !tws) return null;
  const root = splitLeaf(
    tws.root,
    targetPaneTabId,
    dws.root,
    dir,
    placeDraggedFirst,
  );
  // Target pane not found → tree unchanged; grafting nothing while consuming
  // the dragged tab would orphan its panes, so treat as a no-op.
  if (root === tws.root) return null;
  setWorkspace(targetSlotId, { root, focusedTabId: dws.focusedTabId });
  consumeTabIntoWorkspace(draggedTabId);
  activeId.value = targetSlotId;
  return targetSlotId;
}

/** Drop a panel (file browser / git) onto a pane in the target workspace,
 *  splitting the hit pane — the panel-spawning counterpart of
 *  `dropTabIntoTarget`. Used when a + menu option is dragged onto a terminal
 *  (`desc` is just `{ kind }`, an unseeded fresh panel) and when a panel pane
 *  arrives from another window (`desc`/`title` carry its seeds + live title).
 *  Returns the target slot id, or null if the drop wasn't a usable target. */
export function dropPanelIntoTarget(
  desc: PanelDesc,
  targetSlotId: number,
  targetPaneTabId: number,
  dir: SplitDir,
  placeDraggedFirst: boolean,
  title?: string,
): number | null {
  const target = findTab(targetSlotId);
  if (!target || target.kind !== "workspace") return null;
  const tws = getWorkspace(targetSlotId);
  if (!tws) return null;
  const leaf = makePanelLeaf(desc, title);
  const root = splitLeaf(
    tws.root,
    targetPaneTabId,
    leaf,
    dir,
    placeDraggedFirst,
  );
  setWorkspace(targetSlotId, { root, focusedTabId: leaf.tabId });
  activeId.value = targetSlotId;
  return targetSlotId;
}

/** Set the focused pane within a workspace (drives input/selection routing). */
export function focusWorkspacePane(slotId: number, tabId: number): void {
  const ws = getWorkspace(slotId);
  if (!ws || ws.focusedTabId === tabId) return;
  setWorkspace(slotId, { root: ws.root, focusedTabId: tabId });
  syncWorkspaceTabTitle(slotId);
}

export function setActive(id: number): void {
  if (tabs.value.some((t) => t.id === id)) {
    activeId.value = id;
  }
}

/** Reorder a tab within the bar (session-only; no backend).
 *  Moves `id` to sit immediately before `beforeId`; pass null to send it to
 *  the end. Home stays pinned at index 0 and is never a valid target. */
export function moveTab(id: number, beforeId: number | null): void {
  if (id === HOME_TAB_ID) return;
  const from = tabs.value.findIndex((t) => t.id === id);
  if (from < 0) return;
  const moved = tabs.value[from];
  if (moved.kind === "home") return;

  const next = tabs.value.slice();
  next.splice(from, 1);

  let to: number;
  if (beforeId === null) {
    to = next.length;
  } else {
    const refIdx = next.findIndex((t) => t.id === beforeId);
    to = refIdx < 0 ? next.length : refIdx;
  }
  // Never allow insertion at index 0 — home is pinned there.
  const homeIdx = next.findIndex((t) => t.kind === "home");
  if (homeIdx === 0 && to === 0) to = 1;

  next.splice(to, 0, moved);
  tabs.value = next;
}

/** Apply a tree after a pane was removed. Every tab is a workspace, so it never
 *  collapses to a standalone tab: it stays a workspace (a one-pane workspace
 *  just renders full-bleed). When the last pane is gone the whole tab closes
 *  (closing its backend connection). Focus prefers a surviving terminal, then
 *  any pane. */
function applyWorkspaceRemoval(
  slotId: number,
  removedTabId: number,
  newRoot: ReturnType<typeof removeLeaf>,
): void {
  if (!newRoot) {
    void closeTabAndForget(slotId);
    return;
  }
  const ws = getWorkspace(slotId);
  const leaves = collectLeaves(newRoot);
  const terminals = collectTerminalLeaves(newRoot);
  const focusedAlive =
    ws != null &&
    ws.focusedTabId !== removedTabId &&
    leaves.some((l) => l.tabId === ws.focusedTabId);
  // Keyboard input only routes to a terminal, so prefer one for focus.
  const focused = focusedAlive
    ? ws.focusedTabId
    : (terminals[0]?.tabId ?? leaves[0].tabId);
  setWorkspace(slotId, { root: newRoot, focusedTabId: focused });
  if (activeId.value === slotId) renderSeq.value++;
}

export function handleExit(p: ExitPayload): void {
  if (p.tab_id === HOME_TAB_ID) return;
  sshReconnecting.delete(p.tab_id);

  const wsId = workspaceOfLeaf(p.tab_id);
  if (wsId !== undefined) {
    const ws = getWorkspace(wsId);
    snapshots.delete(p.tab_id);
    forgetTab(p.tab_id).catch(() => undefined);
    if (!ws) return;
    applyWorkspaceRemoval(wsId, p.tab_id, removeLeaf(ws.root, p.tab_id));
    return;
  }

  // Defensive fallback: an exit addressed to a slot id (a backend connection
  // registered under a frontend id, e.g. a panel-only workspace's pooled ssh
  // connection) or to an id nothing owns anymore (late exit after tear-off) —
  // tear down whatever state still lingers.
  const idx = tabs.value.findIndex((t) => t.id === p.tab_id);
  if (idx >= 0) {
    if (tabs.value[idx].kind === "workspace") deleteWorkspace(p.tab_id);
    tabs.value.splice(idx, 1);
  }
  snapshots.delete(p.tab_id);
  forgetTab(p.tab_id).catch(() => undefined);
  if (activeId.value === p.tab_id) {
    activeId.value = pickActiveAfterRemoval();
  }
}

/** Move an existing pane next to another pane within the same workspace
 *  (tiling rearrange). Returns true if the tree changed. */
export function moveWorkspaceLeaf(
  slotId: number,
  draggedTabId: number,
  targetPaneTabId: number,
  dir: SplitDir,
  placeDraggedFirst: boolean,
): boolean {
  if (draggedTabId === targetPaneTabId) return false;
  const ws = getWorkspace(slotId);
  if (!ws) return false;
  const leaf = findLeafByTabId(ws.root, draggedTabId);
  if (!leaf || !findLeafByTabId(ws.root, targetPaneTabId)) return false;
  const removed = removeLeaf(ws.root, draggedTabId);
  if (!removed) return false;
  const root = splitLeaf(
    removed,
    targetPaneTabId,
    makeLeaf(draggedTabId, leaf.origin),
    dir,
    placeDraggedFirst,
  );
  // A rearranged panel pane keeps focus where it was — only terminals can
  // hold workspace focus.
  const focusedTabId = isPanelLeaf(leaf) ? ws.focusedTabId : draggedTabId;
  setWorkspace(slotId, { root, focusedTabId });
  return true;
}

/** Pull a pane out of a workspace into its own (1-pane) workspace tab. Works
 *  for terminals (the PTY keeps running) and panels alike: a panel leaf reuses
 *  its own (negative) id as the new slot id, so the detached files/git browser
 *  becomes a self-standing, PTY-less workspace you can split terminals or more
 *  panels into — the same shape the SFTP-only connection workspace already has.
 *  Detaching the slot's primary pane (tabId == slotId) or the only pane is a
 *  no-op for now (cross-tab moves are a later phase). Returns the new tab's
 *  slot id, or null when the detach was a no-op. */
export function detachWorkspaceLeaf(slotId: number, tabId: number): number | null {
  const ws = getWorkspace(slotId);
  if (!ws) return null;
  const leaf = findLeafByTabId(ws.root, tabId);
  if (!leaf) return null;
  if (collectLeaves(ws.root).length <= 1) return null;
  const origin = leaf.origin;
  applyWorkspaceRemoval(slotId, tabId, removeLeaf(ws.root, tabId));
  const t: TabState = {
    id: allocPanelLeafId(),
    kind: "workspace",
    title: snapshots.get(tabId)?.title || origin.title,
    hostLabel: origin.hostLabel,
    hostId: origin.hostId,
    disableSftp: origin.disableSftp,
  };
  tabs.value.push(t);
  setWorkspace(t.id, { root: makeLeaf(tabId, origin), focusedTabId: tabId });
  activeId.value = t.id;
  return t.id;
}

/** Close a single pane (its backend PTY). The exit event then prunes the
 *  workspace tree via handleExit. */
export async function closeWorkspacePane(tabId: number): Promise<void> {
  try {
    await closeTab(tabId);
  } catch {
    /* ignore — exit event still cleans up */
  }
}

export function handleRender(payload: RenderPayload): void {
  // Renders are addressed to backend PTY ids, which only exist as workspace
  // leaves; a render for a leaf no tab owns (already closed / torn off) is
  // dropped.
  const wsId = workspaceOfLeaf(payload.tab_id);
  if (wsId === undefined) return;
  snapshots.set(payload.tab_id, payload);

  // The tab label tracks its focused pane; derive it from the one helper
  // (terminal snapshot title or panel leaf title) so there's a single source
  // of truth rather than this path and the panel/focus paths each copying.
  syncWorkspaceTabTitle(wsId);

  if (wsId === activeId.value) renderSeq.value++;
}

/** Build a workspace tab (+ its initial pane tree) from backend tab info, for
 *  window-restore hydration and tear-off attach. `info.id` is the *backend*
 *  tab id — it becomes the workspace leaf; the tab gets a fresh slot id.
 *  Returns the tab, or null if it's home / already present as a pane. */
function hydrateOne(info: TabHydrateInfo): TabState | null {
  if (info.id === HOME_TAB_ID || workspaceOfLeaf(info.id) !== undefined) {
    return null;
  }
  const isSsh = info.kind === "ssh";
  const fallbackTitle = isSsh
    ? info.host_label ?? `SSH ${info.id}`
    : `Terminal ${info.id}`;
  const t: TabState = {
    id: allocPanelLeafId(),
    kind: "workspace",
    title: fallbackTitle,
    hostId: info.host_id ?? undefined,
    hostLabel: info.host_label ?? undefined,
    disableSftp: info.disable_sftp ?? undefined,
  };
  tabs.value.push(t);
  seedWorkspace(
    t,
    isSsh
      ? sshTerminalLeaf(t, info.id)
      : makeLeaf(info.id, { kind: "terminal", title: fallbackTitle }),
  );
  return t;
}

export function hydrateTabs(infos: TabHydrateInfo[]): void {
  for (const info of infos) hydrateOne(info);
  const firstTerminal = tabs.value.find((t) => t.kind !== "home");
  if (firstTerminal && (activeId.value === HOME_TAB_ID || !tabs.value.some((t) => t.id === activeId.value))) {
    activeId.value = firstTerminal.id;
  }
}

export function attachTab(info: TabHydrateInfo): void {
  const t = hydrateOne(info);
  if (t) activeId.value = t.id;
}

// ---- Panel panes ------------------------------------------------------------
// Panels (file browser, git, …) are workspace leaves like terminals, just
// frontend-only: opening one on a plain tab converts the tab into a workspace
// in place (same slot id, same collapse-back-to-tab behavior when it closes).
// One pane of each kind per workspace; the toggle closes an existing one.

function makePanelLeaf(desc: PanelDesc, title?: string): LeafNode {
  return makeLeaf(allocPanelLeafId(), {
    kind: "panel",
    title: title || panelTitle(desc),
    panel: desc,
  });
}

/** The leaf id of a panel-only tab's single pane, or null when the tab is
 *  multi-pane or terminal-backed — the panel counterpart of
 *  `soleTerminalBackendId`, for whole-tab moves. */
export function solePanelLeafId(slotId: number): number | null {
  const ws = getWorkspace(slotId);
  if (!ws) return null;
  const leaves = collectLeaves(ws.root);
  if (leaves.length !== 1 || !isPanelLeaf(leaves[0])) return null;
  return leaves[0].tabId;
}

/** Snapshot a panel pane for a cross-window move: its `PanelDesc` seeds
 *  (copied — the source leaf is about to be closed) and live title. Panels
 *  persist their current folder back onto the seed (`setPanelLeafSeedPath`),
 *  so recreating from this snapshot reopens the panel where it was. */
export function panelLeafSnapshot(
  slotId: number,
  leafId: number,
): { desc: PanelDesc; title: string } | null {
  const ws = getWorkspace(slotId);
  const leaf = ws ? findLeafByTabId(ws.root, leafId) : null;
  if (!leaf || !leaf.origin.panel) return null;
  return { desc: { ...leaf.origin.panel }, title: leaf.origin.title };
}

/** Close a panel pane; the workspace closes entirely when its last pane goes.
 *  A files panel releases its SFTP consumer (dropping the pooled connection if
 *  it was the last consumer). */
export function closePanelLeaf(slotId: number, leafId: number): void {
  const ws = getWorkspace(slotId);
  if (!ws) return;
  const leaf = findLeafByTabId(ws.root, leafId);
  applyWorkspaceRemoval(slotId, leafId, removeLeaf(ws.root, leafId));
  if (leaf?.origin.panel?.kind === "files") releaseSftpForPane(leafId);
}

/** Mirror the focused pane's title onto the workspace's tab-bar label, so the
 *  tab tracks whichever pane has focus. Terminals normally do this via their
 *  render payloads (`handleRender`), but panels emit no renders and the tab
 *  label otherwise never learns their title — this covers both. No-op outside
 *  a workspace. */
function syncWorkspaceTabTitle(slotId: number): void {
  const ws = getWorkspace(slotId);
  const slot = findTab(slotId);
  if (!ws || !slot || slot.kind !== "workspace") return;
  const leaf = findLeafByTabId(ws.root, ws.focusedTabId);
  if (!leaf) return;
  const title = isPanelLeaf(leaf)
    ? leaf.origin.title
    : snapshots.get(leaf.tabId)?.title || leaf.origin.title;
  if (title && slot.title !== title) slot.title = title;
}

/** Update a panel pane's title (its hover-pill label). Panels are
 *  self-contained, so they report their own live title — the current source /
 *  repo — via `@update:title`; this writes it onto the leaf and bumps the
 *  workspace so the layout re-reads it. When the panel is the focused pane its
 *  title also drives the tab-bar label. No-op if unchanged or not a panel. */
export function setPanelLeafTitle(leafId: number, title: string): void {
  const slotId = workspaceOfLeaf(leafId);
  if (slotId == null) return;
  const ws = getWorkspace(slotId);
  if (!ws) return;
  const leaf = findLeafByTabId(ws.root, leafId);
  if (!leaf || !leaf.origin.panel || leaf.origin.title === title) return;
  leaf.origin.title = title;
  setWorkspace(slotId, ws);
  if (ws.focusedTabId === leafId) syncWorkspaceTabTitle(slotId);
}

/** Persist a panel pane's current folder back onto its leaf seed. Panels keep
 *  their working folder in component state; without this the picked folder is
 *  lost when the leaf is detached/re-tiled and the panel re-mounts from its
 *  (stale) original seed. Writes straight onto the leaf's `PanelDesc` — no
 *  reflow, since panels read `seedPath` only on mount. No-op if unchanged or
 *  not a panel. */
export function setPanelLeafSeedPath(leafId: number, seedPath: string): void {
  const slotId = workspaceOfLeaf(leafId);
  if (slotId == null) return;
  const ws = getWorkspace(slotId);
  if (!ws) return;
  const leaf = findLeafByTabId(ws.root, leafId);
  if (!leaf || !leaf.origin.panel || leaf.origin.panel.seedPath === seedPath)
    return;
  leaf.origin.panel.seedPath = seedPath;
}

/** Terminal leaves of a workspace (`{ id, title, focused }`), for the files
 *  panel's cd / insert-path target submenu. Read inside a computed that also
 *  touches `workspaceTick` for reactivity to pane add/remove. */
export function listWorkspaceTerminals(
  slotId: number,
): { id: number; title: string; focused: boolean }[] {
  const ws = getWorkspace(slotId);
  if (!ws) return [];
  return collectTerminalLeaves(ws.root).map((l) => ({
    id: l.tabId,
    title: snapshots.get(l.tabId)?.title || l.origin.title,
    focused: l.tabId === ws.focusedTabId,
  }));
}

/** Open a new, self-contained panel pane in the active workspace next to the
 *  pane `fromTabId` (falling back to the focused pane). Always adds a fresh
 *  pane — panels don't toggle. */
export function openPanelPane(
  kind: PanelKind,
  fromTabId: number,
  desc: PanelDesc,
): void {
  const a = findTab(activeId.value);
  if (!a || a.kind !== "workspace") return;
  const ws = getWorkspace(a.id);
  if (!ws) return;
  // With no terminal pane to anchor on (e.g. a files-only workspace), allow
  // splitting beside a panel; otherwise anchor on a terminal pane.
  const panelOnly = collectTerminalLeaves(ws.root).length === 0;
  // Split the originating pane so the panel opens next to it; fall back to the
  // focused pane if `fromTabId` isn't a usable anchor here.
  let anchor = fromTabId;
  let anchorLeaf = findLeafByTabId(ws.root, anchor);
  if (!anchorLeaf || (isPanelLeaf(anchorLeaf) && !panelOnly)) {
    anchor = ws.focusedTabId;
    anchorLeaf = findLeafByTabId(ws.root, anchor);
  }
  if (!anchorLeaf || (isPanelLeaf(anchorLeaf) && !panelOnly)) return;
  const root = splitLeaf(
    ws.root,
    anchor,
    makePanelLeaf(desc),
    "h",
    false,
    PANEL_SPLIT_RATIO[kind],
  );
  setWorkspace(a.id, { root, focusedTabId: ws.focusedTabId });
  if (
    kind === "files" &&
    anchorLeaf.origin.kind === "ssh" &&
    !anchorLeaf.origin.disableSftp
  )
    setSftpAutoOpen(true);
}

/** Open a panel seeded from a terminal pane (pill buttons, Cmd/Ctrl+B / +G).
 *  The panel is independent (the user can switch source/folder inside it), but
 *  it opens seeded to its originating terminal: a files panel on an SSH pane
 *  seeds straight to that host's SFTP; otherwise it opens on **local** files
 *  seeded to the terminal's cwd. A git panel seeds its folder from a local
 *  cwd; SSH cwd isn't known here, so SSH git panes just open local/home. */
export async function openPanelFromTerminal(
  kind: PanelKind,
  terminalTabId: number,
): Promise<void> {
  const desc: PanelDesc = { kind, seedTargetTabId: terminalTabId };
  // If the originating pane is an SSH session, open the files browser straight
  // on that server's SFTP rather than local files. Every host is SFTP-capable —
  // `disableSftp` ("Shell only") only defers the subsystem to first browse and
  // suppresses *auto*-opening a panel; an explicit button press still wants the
  // remote browser, so it isn't gated here.
  const slotId = workspaceOfLeaf(terminalTabId);
  const ws = slotId != null ? getWorkspace(slotId) : null;
  const leaf = ws ? findLeafByTabId(ws.root, terminalTabId) : null;
  if (
    kind === "files" &&
    leaf?.origin.kind === "ssh" &&
    leaf.origin.hostId != null
  ) {
    desc.seedHostId = leaf.origin.hostId;
    openPanelPane(kind, terminalTabId, desc);
    return;
  }
  // Local terminal cwd (pid→cwd lookup; null for SSH — the panel then falls
  // back to its remembered dir / home).
  const cwd = await terminalCwd(terminalTabId).catch(() => null);
  if (cwd) desc.seedPath = cwd;
  openPanelPane(kind, terminalTabId, desc);
}

/** Open a panel from the active tab's terminal (keyboard shortcuts): the
 *  focused pane of a workspace, or the active terminal/ssh tab itself. */
export async function openPanelOnActive(kind: PanelKind): Promise<void> {
  const a = findTab(activeId.value);
  if (!a || a.kind === "home") return;
  let termId = a.id;
  if (a.kind === "workspace") {
    const ws = getWorkspace(a.id);
    if (!ws) return;
    termId = ws.focusedTabId;
  }
  await openPanelFromTerminal(kind, termId);
}

/** Local-only removal of a single pane — its backend still exists, it has
 *  just moved to another window (cross-window pane drag). The `removeTabLocal`
 *  counterpart at leaf granularity: prune the leaf and its per-leaf state
 *  without touching the backend. Callers must guarantee the workspace keeps
 *  at least one other pane — on an emptied tree `applyWorkspaceRemoval` would
 *  close the whole tab, which closes remaining backends by id and could reap
 *  the very pane that just moved. */
export function removeWorkspaceLeafLocal(slotId: number, tabId: number): void {
  const ws = getWorkspace(slotId);
  if (!ws) return;
  snapshots.delete(tabId);
  sshReconnecting.delete(tabId);
  applyWorkspaceRemoval(slotId, tabId, removeLeaf(ws.root, tabId));
}

/** Local-only removal — the tab's backends still exist, they have just moved
 *  to another window. Don't call closeTab/forgetTab; do drop the workspace
 *  tree and per-leaf state so nothing here keeps mapping the moved panes. */
export function removeTabLocal(id: number): void {
  if (id === HOME_TAB_ID) return;
  const idx = tabs.value.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const ws = getWorkspace(id);
  tabs.value.splice(idx, 1);
  if (ws) {
    for (const leaf of collectLeaves(ws.root)) {
      snapshots.delete(leaf.tabId);
      // If it was mid-reconnect, the destination window re-acquires the flag
      // on the next retry — "ssh:reconnecting" re-fires on every failed
      // attempt.
      sshReconnecting.delete(leaf.tabId);
    }
  }
  deleteWorkspace(id);
  if (activeId.value === id) {
    const next = tabs.value.find((t) => t.kind !== "home");
    activeId.value = next ? next.id : HOME_TAB_ID;
  }
}
