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
  type TabOrigin,
} from "./workspace";
import {
  allocPanelLeafId,
  panelTitle,
  PANEL_SPLIT_RATIO,
  type PanelDesc,
  type PanelKind,
} from "./panels";
import { setSftpAutoOpen, sftpAutoOpen } from "./sftp";

export const HOME_TAB_ID = 0;

export type TabKind = "home" | "terminal" | "ssh" | "workspace";

export interface TabState {
  id: number;
  kind: TabKind;
  title: string;
  hostLabel?: string;
  hostId?: number;
  /** SSH tabs only: the host opted out of SFTP, so no file-browser panel. */
  disableSftp?: boolean;
  /** SSH tabs only: SFTP-only host — no shell; renders as a full-width
   *  file browser instead of a terminal. */
  disableSsh?: boolean;
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
    tabs.value.filter((t) => t.kind === "terminal" || t.kind === "ssh"),
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

/** All open SSH connections in this window — standalone SSH tabs plus SSH
 *  panes inside workspaces. Used by the SFTP browser's connection picker.
 *  Read inside a computed that also touches `workspaceTick` for reactivity to
 *  pane changes. */
export function listSshConnections(): {
  id: number;
  label: string;
  disableSftp: boolean;
}[] {
  const out: { id: number; label: string; disableSftp: boolean }[] = [];
  for (const t of tabs.value) {
    if (t.kind === "ssh") {
      out.push({
        id: t.id,
        label: t.hostLabel || t.title,
        disableSftp: !!t.disableSftp,
      });
    } else if (t.kind === "workspace") {
      const ws = getWorkspace(t.id);
      if (!ws) continue;
      for (const leaf of collectLeaves(ws.root)) {
        if (leaf.origin.kind === "ssh") {
          out.push({
            id: leaf.tabId,
            label: leaf.origin.hostLabel || leaf.origin.title,
            disableSftp: !!leaf.origin.disableSftp,
          });
        }
      }
    }
  }
  return out;
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

/** True if `tabId` is a standalone SSH tab or an SSH pane in a workspace.
 *  (A plain `kind === "ssh"` check misses panes — including SSH tabs that
 *  were converted to workspaces by opening a panel.) */
export function isSshTabOrPane(tabId: number): boolean {
  if (findTab(tabId)?.kind === "ssh") return true;
  const wsId = workspaceOfLeaf(tabId);
  if (wsId === undefined) return false;
  const ws = getWorkspace(wsId);
  return !!ws && findLeafByTabId(ws.root, tabId)?.origin.kind === "ssh";
}

function originOf(t: TabState): TabOrigin {
  return {
    kind: t.kind === "ssh" ? "ssh" : "terminal",
    title: t.title,
    hostLabel: t.hostLabel,
    hostId: t.hostId,
    disableSftp: t.disableSftp,
    disableSsh: t.disableSsh,
  };
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

export async function spawnTerminal(args: {
  cols: number;
  rows: number;
  cellWidthPx: number;
  cellHeightPx: number;
}): Promise<number> {
  const id = await spawnTab(args);
  tabs.value.push({ id, kind: "terminal", title: "Terminal" });
  activeId.value = id;
  return id;
}

export async function spawnSsh(args: {
  hostId: number;
  hostLabel: string;
  cols: number;
  rows: number;
  cellWidthPx: number;
  cellHeightPx: number;
  config: import("../ipc").SshConnectConfig;
}): Promise<number> {
  const id = await connectSshHost({
    config: args.config,
    cols: args.cols,
    rows: args.rows,
    cellWidthPx: args.cellWidthPx,
    cellHeightPx: args.cellHeightPx,
  });
  tabs.value.push({
    id,
    kind: "ssh",
    title: args.hostLabel,
    hostLabel: args.hostLabel,
    hostId: args.hostId,
    disableSftp: args.config.disable_sftp,
    disableSsh: args.config.disable_ssh,
  });
  activeId.value = id;
  const t = findTab(id);
  if (t) maybeAutoOpenFiles(t);
  return id;
}

/** The file browser auto-opens for SSH tabs unless the user last closed it
 *  (the remembered default). SFTP-only hosts already *are* a full-width
 *  browser; hosts that opted out of SFTP get nothing. Applies to fresh
 *  connects, window-restore hydration, and tabs attached via tear-off. */
function maybeAutoOpenFiles(t: TabState): void {
  if (t.kind !== "ssh" || t.disableSsh || t.disableSftp) return;
  if (sftpAutoOpen())
    openPanelOnTab(t, {
      kind: "files",
      seedSshTabId: t.id,
      seedTargetTabId: t.id,
    });
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
        // Panel leaves are frontend-only views — nothing to close backend-side.
        if (!isPanelLeaf(leaf)) closeTab(leaf.tabId).catch(() => undefined);
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

/** Splice a tab out of the bar without touching the backend — its PTY lives
 *  on as a workspace pane. (Mirrors removeTabLocal but keeps the snapshot.) */
function consumeTabIntoWorkspace(id: number): void {
  spliceTab(id);
}

/** Drop `draggedTabId` onto a pane. If the target is a plain tab it becomes a
 *  new workspace; if it's already a workspace the hit pane is split. Returns
 *  the workspace slot id, or null if the drop was a no-op. */
export function dropTabIntoTarget(
  draggedTabId: number,
  targetSlotId: number,
  targetPaneTabId: number,
  dir: SplitDir,
  placeDraggedFirst: boolean,
): number | null {
  if (draggedTabId === targetPaneTabId) return null;
  const dragged = findTab(draggedTabId);
  const target = findTab(targetSlotId);
  if (!dragged || !target || dragged.kind === "home" || target.kind === "home") {
    return null;
  }
  // SFTP-only tabs render as a full-width file browser, not a terminal pane —
  // they never join workspaces, in either role.
  if (dragged.disableSsh || target.disableSsh) return null;
  const draggedLeaf = makeLeaf(draggedTabId, originOf(dragged));

  if (target.kind === "workspace") {
    const ws = getWorkspace(targetSlotId);
    if (!ws) return null;
    const root = splitLeaf(
      ws.root,
      targetPaneTabId,
      draggedLeaf,
      dir,
      placeDraggedFirst,
    );
    setWorkspace(targetSlotId, { root, focusedTabId: draggedTabId });
    consumeTabIntoWorkspace(draggedTabId);
    activeId.value = targetSlotId;
    return targetSlotId;
  }

  // Plain target → convert it into a workspace in place (keeps its slot id so
  // the tab-bar position/animation stay stable).
  const targetLeaf = makeLeaf(target.id, originOf(target));
  const root = placeDraggedFirst
    ? makeSplit(dir, draggedLeaf, targetLeaf)
    : makeSplit(dir, targetLeaf, draggedLeaf);
  const slotId = target.id;
  target.kind = "workspace";
  target.title = dragged.title;
  target.hostLabel = undefined;
  target.hostId = undefined;
  setWorkspace(slotId, { root, focusedTabId: draggedTabId });
  consumeTabIntoWorkspace(draggedTabId);
  activeId.value = slotId;
  return slotId;
}

/** Set the focused pane within a workspace (drives input/selection routing). */
export function focusWorkspacePane(slotId: number, tabId: number): void {
  const ws = getWorkspace(slotId);
  if (!ws || ws.focusedTabId === tabId) return;
  setWorkspace(slotId, { root: ws.root, focusedTabId: tabId });
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

/** A workspace lost a leaf and now has ≤1 pane: drop the workspace and turn
 *  its slot back into a normal tab for the survivor (or remove it entirely).
 *  A panel survivor can't stand alone as a tab — it counts as no survivor. */
function revertOrRemoveSlot(slotId: number, survivor: LeafNode | null): void {
  if (survivor && isPanelLeaf(survivor)) survivor = null;
  deleteWorkspace(slotId);
  const slot = findTab(slotId);
  if (survivor && slot) {
    const o = survivor.origin;
    slot.id = survivor.tabId;
    slot.kind = o.kind as "terminal" | "ssh"; // panel survivors filtered above
    slot.title = snapshots.get(survivor.tabId)?.title || o.title;
    slot.hostLabel = o.hostLabel;
    slot.hostId = o.hostId;
    slot.disableSftp = o.disableSftp;
    slot.disableSsh = o.disableSsh;
    if (activeId.value === slotId) activeId.value = survivor.tabId;
  } else {
    spliceTab(slotId);
    if (activeId.value === slotId) activeId.value = pickActiveAfterRemoval();
  }
}

/** Apply a tree after a leaf was removed: collapse to a tab if ≤1 pane left,
 *  otherwise keep the workspace and fix focus if the focused pane went away.
 *  Panels can't outlive their workspace's terminals: when no terminal leaf
 *  remains, the whole slot goes (the panel panes simply unmount). */
function applyWorkspaceRemoval(
  slotId: number,
  removedTabId: number,
  newRoot: ReturnType<typeof removeLeaf>,
): void {
  const ws = getWorkspace(slotId);
  // Panels are self-contained, so a removed terminal does NOT take any panels
  // with it — sibling file/git panes survive. The workspace only collapses
  // once no terminal leaf remains (handled below): panels can't keep a
  // workspace alive on their own.
  if (!newRoot || newRoot.kind === "leaf") {
    revertOrRemoveSlot(slotId, newRoot && newRoot.kind === "leaf" ? newRoot : null);
    return;
  }
  const terminals = collectTerminalLeaves(newRoot);
  if (terminals.length === 0) {
    revertOrRemoveSlot(slotId, null);
    return;
  }
  // Focus must stay on a terminal leaf — panel panes own their DOM focus and
  // never receive PTY input.
  const focusedAlive =
    ws != null &&
    ws.focusedTabId !== removedTabId &&
    terminals.some((l) => l.tabId === ws.focusedTabId);
  const focused = focusedAlive ? ws.focusedTabId : terminals[0].tabId;
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

  const idx = tabs.value.findIndex((t) => t.id === p.tab_id);
  if (idx >= 0) tabs.value.splice(idx, 1);
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

/** Pull a pane out of a workspace back into its own standalone tab. The PTY
 *  keeps running; the workspace collapses if it drops to ≤1 pane. */
export function detachWorkspaceLeaf(slotId: number, tabId: number): void {
  const ws = getWorkspace(slotId);
  if (!ws) return;
  const leaf = findLeafByTabId(ws.root, tabId);
  if (!leaf) return;
  // Panel panes live only inside workspaces — there is no standalone tab to
  // detach into.
  if (isPanelLeaf(leaf)) return;
  const newRoot = removeLeaf(ws.root, tabId);
  // Collapse/revert the workspace BEFORE pushing the detached tab: when the
  // detached leaf's id doubles as the slot id (a tab upgraded in place by a
  // drop or a panel open), findTab(tabId) would otherwise hit the workspace
  // slot, skip the push, and the revert would strand the live PTY without a
  // tab. After the removal the slot has been reassigned or spliced, so the
  // check is accurate.
  applyWorkspaceRemoval(slotId, tabId, newRoot);
  if (!findTab(tabId)) {
    tabs.value.push({
      id: tabId,
      kind: leaf.origin.kind as "terminal" | "ssh", // panels rejected above
      title: snapshots.get(tabId)?.title || leaf.origin.title,
      hostLabel: leaf.origin.hostLabel,
      hostId: leaf.origin.hostId,
      disableSftp: leaf.origin.disableSftp,
      disableSsh: leaf.origin.disableSsh,
    });
  }
  activeId.value = tabId;
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
  const wsId = workspaceOfLeaf(payload.tab_id);
  const t = tabs.value.find((x) => x.id === payload.tab_id);
  // A workspace leaf has no TabState of its own (it was consumed), but its
  // snapshot must still be cached so the pane can render.
  if (!t && wsId === undefined) return;
  snapshots.set(payload.tab_id, payload);

  if (payload.title && payload.title.length > 0) {
    if (t && t.kind !== "workspace" && payload.title !== t.title) {
      t.title = payload.title;
    }
    if (wsId !== undefined) {
      const ws = getWorkspace(wsId);
      const slot = findTab(wsId);
      if (ws && slot && ws.focusedTabId === payload.tab_id) {
        slot.title = payload.title;
      }
    }
  }

  if (payload.tab_id === activeId.value || wsId === activeId.value) {
    renderSeq.value++;
  }
}

export function hydrateTabs(infos: TabHydrateInfo[]): void {
  for (const info of infos) {
    if (info.id === HOME_TAB_ID || tabs.value.some((t) => t.id === info.id)) {
      continue;
    }
    const kind: TabKind = info.kind === "ssh" ? "ssh" : "terminal";
    const fallbackTitle =
      kind === "ssh"
        ? info.host_label ?? `SSH ${info.id}`
        : `Terminal ${info.id}`;
    const t: TabState = {
      id: info.id,
      kind,
      title: fallbackTitle,
      hostId: info.host_id ?? undefined,
      hostLabel: info.host_label ?? undefined,
      disableSftp: info.disable_sftp ?? undefined,
      disableSsh: info.disable_ssh ?? undefined,
    };
    tabs.value.push(t);
    maybeAutoOpenFiles(t);
  }
  const firstTerminal = tabs.value.find((t) => t.kind !== "home");
  if (firstTerminal && (activeId.value === HOME_TAB_ID || !tabs.value.some((t) => t.id === activeId.value))) {
    activeId.value = firstTerminal.id;
  }
}

export function attachTab(info: TabHydrateInfo): void {
  if (info.id === HOME_TAB_ID || tabs.value.some((t) => t.id === info.id)) return;
  const kind: TabKind = info.kind === "ssh" ? "ssh" : "terminal";
  const fallbackTitle =
    kind === "ssh" ? info.host_label ?? `SSH ${info.id}` : `Terminal ${info.id}`;
  const t: TabState = {
    id: info.id,
    kind,
    title: fallbackTitle,
    hostId: info.host_id ?? undefined,
    hostLabel: info.host_label ?? undefined,
    disableSftp: info.disable_sftp ?? undefined,
    disableSsh: info.disable_ssh ?? undefined,
  };
  tabs.value.push(t);
  maybeAutoOpenFiles(t);
  activeId.value = info.id;
}

// ---- Panel panes ------------------------------------------------------------
// Panels (file browser, git, …) are workspace leaves like terminals, just
// frontend-only: opening one on a plain tab converts the tab into a workspace
// in place (same slot id, same collapse-back-to-tab behavior when it closes).
// One pane of each kind per workspace; the toggle closes an existing one.

function makePanelLeaf(desc: PanelDesc): LeafNode {
  return makeLeaf(allocPanelLeafId(), {
    kind: "panel",
    title: panelTitle(desc),
    panel: desc,
  });
}

/** Convert a standalone terminal/ssh tab into a two-pane workspace hosting
 *  the tab plus a new panel (mirrors dropTabIntoTarget's in-place upgrade). */
function openPanelOnTab(t: TabState, desc: PanelDesc): void {
  const termLeaf = makeLeaf(t.id, originOf(t));
  const root = makeSplit(
    "h",
    termLeaf,
    makePanelLeaf(desc),
    PANEL_SPLIT_RATIO[desc.kind],
  );
  const slotId = t.id;
  // Unlike a tab-merge (dropTabIntoTarget), the workspace is born from this
  // one tab — keep hostLabel/hostId so notifications still name the host.
  t.kind = "workspace";
  setWorkspace(slotId, { root, focusedTabId: termLeaf.tabId });
}

/** Close a panel pane; the workspace collapses back to a plain tab when only
 *  one terminal remains. */
export function closePanelLeaf(slotId: number, leafId: number): void {
  const ws = getWorkspace(slotId);
  if (!ws) return;
  applyWorkspaceRemoval(slotId, leafId, removeLeaf(ws.root, leafId));
}

/** ssh-ness of a terminal tab or pane, for seeding a files panel. */
function terminalSeedInfo(tabId: number): { isSsh: boolean; disableSftp: boolean } {
  const t = findTab(tabId);
  if (t && t.kind === "ssh") return { isSsh: true, disableSftp: !!t.disableSftp };
  const wsId = workspaceOfLeaf(tabId);
  if (wsId !== undefined) {
    const ws = getWorkspace(wsId);
    const leaf = ws ? findLeafByTabId(ws.root, tabId) : null;
    if (leaf && leaf.origin.kind === "ssh")
      return { isSsh: true, disableSftp: !!leaf.origin.disableSftp };
  }
  return { isSsh: false, disableSftp: false };
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

/** Open a new, self-contained panel pane on the active tab next to the
 *  terminal pane `fromTabId` (falling back to the focused pane). Always adds
 *  a fresh pane — panels no longer toggle. On a plain tab the tab becomes a
 *  workspace. */
export function openPanelPane(
  kind: PanelKind,
  fromTabId: number,
  desc: PanelDesc,
): void {
  const a = findTab(activeId.value);
  if (!a || a.kind === "home") return;
  // SFTP-only tabs are already a full-width file browser with no terminal to
  // tile against.
  if (a.kind === "ssh" && a.disableSsh) return;

  if (a.kind !== "workspace") {
    openPanelOnTab(a, desc);
    if (kind === "files" && a.kind === "ssh") setSftpAutoOpen(true);
    return;
  }

  const ws = getWorkspace(a.id);
  if (!ws) return;
  // Split the originating terminal pane so the panel opens next to it; fall
  // back to the focused pane if `fromTabId` isn't a terminal leaf here.
  let anchor = fromTabId;
  let anchorLeaf = findLeafByTabId(ws.root, anchor);
  if (!anchorLeaf || isPanelLeaf(anchorLeaf)) {
    anchor = ws.focusedTabId;
    anchorLeaf = findLeafByTabId(ws.root, anchor);
  }
  if (!anchorLeaf || isPanelLeaf(anchorLeaf)) return;
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

/** Open a panel seeded from a terminal pane (pill buttons, Cmd/Ctrl+B / +G):
 *  a files panel on an SSH pane pre-selects that server; on a local pane (and
 *  any git panel) it seeds the folder from the terminal's cwd. The opened
 *  panel is independent — it targets / follows nothing automatically. */
export async function openPanelFromTerminal(
  kind: PanelKind,
  terminalTabId: number,
): Promise<void> {
  const desc: PanelDesc = { kind, seedTargetTabId: terminalTabId };
  const info = terminalSeedInfo(terminalTabId);
  if (kind === "files" && info.isSsh && !info.disableSftp) {
    desc.seedSshTabId = terminalTabId;
  } else {
    // Local terminal cwd (pid→cwd lookup; null for SSH — the panel then
    // falls back to its remembered dir / home).
    const cwd = await terminalCwd(terminalTabId).catch(() => null);
    if (cwd) desc.seedPath = cwd;
  }
  openPanelPane(kind, terminalTabId, desc);
}

/** Open a panel from the active tab's terminal (keyboard shortcuts): the
 *  focused pane of a workspace, or the active terminal/ssh tab itself. */
export async function openPanelOnActive(kind: PanelKind): Promise<void> {
  const a = findTab(activeId.value);
  if (!a || a.kind === "home") return;
  if (a.kind === "ssh" && a.disableSsh) return;
  let termId = a.id;
  if (a.kind === "workspace") {
    const ws = getWorkspace(a.id);
    if (!ws) return;
    termId = ws.focusedTabId;
  }
  await openPanelFromTerminal(kind, termId);
}

/** Local-only removal — the tab still exists on the backend, it has just
 *  moved to another window. Don't call closeTab/forgetTab. */
export function removeTabLocal(id: number): void {
  if (id === HOME_TAB_ID) return;
  const idx = tabs.value.findIndex((t) => t.id === id);
  if (idx < 0) return;
  tabs.value.splice(idx, 1);
  snapshots.delete(id);
  // If it was mid-reconnect, the destination window re-acquires the flag on
  // the next retry — "ssh:reconnecting" re-fires on every failed attempt.
  sshReconnecting.delete(id);
  if (activeId.value === id) {
    const next = tabs.value.find((t) => t.kind !== "home");
    activeId.value = next ? next.id : HOME_TAB_ID;
  }
}
