import { ref } from "vue";

import type { PanelDesc } from "./panels";

// A workspace is a recursive (tmux-like) binary tiling tree. Each leaf is
// either a backend tab (its own PTY/thread/render stream) or a frontend
// panel (file browser, git, … — see state/panels.ts); each split divides its
// area horizontally ("h" → side-by-side, vertical divider) or vertically
// ("v" → stacked, horizontal divider). A workspace occupies one tab-bar slot
// whose TabState.id is reused as the registry key.

export type SplitDir = "h" | "v";

/** Snapshot of the originating tab so a collapse (workspace → single pane)
 *  can restore the surviving leaf to a normal tab without losing ssh info.
 *  Panel leaves (kind "panel") have no originating tab — they exist only as
 *  workspace panes and carry their view descriptor instead. */
export interface TabOrigin {
  kind: "terminal" | "ssh" | "panel";
  title: string;
  hostLabel?: string;
  hostId?: number;
  /** SSH panes only: the host opted out of SFTP. */
  disableSftp?: boolean;
  /** SSH panes only: SFTP-only host (no shell). Such tabs never actually
   *  join workspaces; carried for completeness when origins are copied. */
  disableSsh?: boolean;
  /** Panel leaves only: what the pane shows. */
  panel?: PanelDesc;
}

export function isPanelLeaf(leaf: LeafNode): boolean {
  return leaf.origin.kind === "panel";
}

/** Leaves backed by a real PTY tab (terminal or ssh), i.e. not panels. */
export function collectTerminalLeaves(node: WorkspaceNode): LeafNode[] {
  return collectLeaves(node).filter((l) => !isPanelLeaf(l));
}

export interface LeafNode {
  kind: "leaf";
  id: string;
  tabId: number;
  origin: TabOrigin;
}

export interface SplitNode {
  kind: "split";
  id: string;
  dir: SplitDir;
  ratio: number; // 0..1, fraction of the usable extent given to `a`
  a: WorkspaceNode;
  b: WorkspaceNode;
}

export type WorkspaceNode = LeafNode | SplitNode;

export interface Workspace {
  root: WorkspaceNode;
  focusedTabId: number;
}

export interface PaneRect {
  tabId: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DividerRect {
  splitId: string;
  dir: SplitDir;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Draggable divider thickness in CSS px. */
export const GUTTER = 6;

let nodeSeq = 1;
function nodeId(): string {
  return `n${nodeSeq++}`;
}

export function makeLeaf(tabId: number, origin: TabOrigin): LeafNode {
  return { kind: "leaf", id: nodeId(), tabId, origin };
}

export function makeSplit(
  dir: SplitDir,
  a: WorkspaceNode,
  b: WorkspaceNode,
  ratio = 0.5,
): SplitNode {
  return { kind: "split", id: nodeId(), dir, ratio, a, b };
}

// ---- Pure tree operations (immutable; return new nodes) --------------------

export function collectLeaves(node: WorkspaceNode): LeafNode[] {
  if (node.kind === "leaf") return [node];
  return [...collectLeaves(node.a), ...collectLeaves(node.b)];
}

export function findLeafByTabId(
  node: WorkspaceNode,
  tabId: number,
): LeafNode | null {
  if (node.kind === "leaf") return node.tabId === tabId ? node : null;
  return findLeafByTabId(node.a, tabId) ?? findLeafByTabId(node.b, tabId);
}

/** Replace the leaf for `targetTabId` with a split that also holds a new leaf
 *  for `newTabId`. `placeNewFirst` puts the new pane on the left/top. `ratio`
 *  is the fraction kept by the first child (default even split). */
export function splitLeaf(
  root: WorkspaceNode,
  targetTabId: number,
  newLeaf: LeafNode,
  dir: SplitDir,
  placeNewFirst: boolean,
  ratio = 0.5,
): WorkspaceNode {
  if (root.kind === "leaf") {
    if (root.tabId !== targetTabId) return root;
    return placeNewFirst
      ? makeSplit(dir, newLeaf, root, 1 - ratio)
      : makeSplit(dir, root, newLeaf, ratio);
  }
  const a = splitLeaf(root.a, targetTabId, newLeaf, dir, placeNewFirst, ratio);
  const b = splitLeaf(root.b, targetTabId, newLeaf, dir, placeNewFirst, ratio);
  if (a === root.a && b === root.b) return root;
  return { ...root, a, b };
}

/** Remove the leaf for `tabId`, collapsing any split that loses a child into
 *  its surviving sibling. Returns the new root, or null if nothing remains. */
export function removeLeaf(
  node: WorkspaceNode,
  tabId: number,
): WorkspaceNode | null {
  if (node.kind === "leaf") return node.tabId === tabId ? null : node;
  const a = removeLeaf(node.a, tabId);
  const b = removeLeaf(node.b, tabId);
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

export function setRatio(
  node: WorkspaceNode,
  splitId: string,
  ratio: number,
): WorkspaceNode {
  if (node.kind === "leaf") return node;
  if (node.id === splitId) {
    return { ...node, ratio: Math.max(0.05, Math.min(0.95, ratio)) };
  }
  const a = setRatio(node.a, splitId, ratio);
  const b = setRatio(node.b, splitId, ratio);
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

// ---- Layout ---------------------------------------------------------------

/** Tile `node` into the (x,y,w,h) CSS-px rect, reserving GUTTER strips for
 *  dividers. Pane rects are integer-snapped so cols/rows stay stable and
 *  panes don't develop sub-pixel seams in deep trees. */
export function layout(
  node: WorkspaceNode,
  x: number,
  y: number,
  w: number,
  h: number,
): {
  panes: PaneRect[];
  dividers: DividerRect[];
  splitBoxes: Map<string, { x: number; y: number; w: number; h: number }>;
} {
  const panes: PaneRect[] = [];
  const dividers: DividerRect[] = [];
  const splitBoxes = new Map<string, { x: number; y: number; w: number; h: number }>();

  const recurse = (n: WorkspaceNode, rx: number, ry: number, rw: number, rh: number) => {
    if (n.kind === "split") {
      splitBoxes.set(n.id, { x: rx, y: ry, w: rw, h: rh });
    }
    if (n.kind === "leaf") {
      panes.push({
        tabId: n.tabId,
        x: Math.round(rx),
        y: Math.round(ry),
        w: Math.max(1, Math.round(rw)),
        h: Math.max(1, Math.round(rh)),
      });
      return;
    }
    if (n.dir === "h") {
      const avail = Math.max(1, rw - GUTTER);
      const aw = Math.round(avail * n.ratio);
      recurse(n.a, rx, ry, aw, rh);
      dividers.push({ splitId: n.id, dir: "h", x: Math.round(rx + aw), y: Math.round(ry), w: GUTTER, h: Math.round(rh) });
      recurse(n.b, rx + aw + GUTTER, ry, rw - aw - GUTTER, rh);
    } else {
      const avail = Math.max(1, rh - GUTTER);
      const ah = Math.round(avail * n.ratio);
      recurse(n.a, rx, ry, rw, ah);
      dividers.push({ splitId: n.id, dir: "v", x: Math.round(rx), y: Math.round(ry + ah), w: Math.round(rw), h: GUTTER });
      recurse(n.b, rx, ry + ah + GUTTER, rw, rh - ah - GUTTER);
    }
  };

  recurse(node, x, y, w, h);
  return { panes, dividers, splitBoxes };
}

// ---- Registry -------------------------------------------------------------

// Heavy structures live outside Vue reactivity (same rationale as the snapshot
// map in tabs.ts). `workspaceTick` is the reactive signal that something
// structural changed so views can re-layout/redraw.
const workspaces = new Map<number, Workspace>();
const leafToWorkspace = new Map<number, number>();
export const workspaceTick = ref(0);

function reindex(slotId: number, ws: Workspace): void {
  for (const [tabId, owner] of leafToWorkspace) {
    if (owner === slotId) leafToWorkspace.delete(tabId);
  }
  for (const leaf of collectLeaves(ws.root)) {
    leafToWorkspace.set(leaf.tabId, slotId);
  }
}

export function getWorkspace(slotId: number): Workspace | undefined {
  return workspaces.get(slotId);
}

export function setWorkspace(slotId: number, ws: Workspace): void {
  workspaces.set(slotId, ws);
  reindex(slotId, ws);
  workspaceTick.value++;
}

export function deleteWorkspace(slotId: number): void {
  for (const [tabId, owner] of leafToWorkspace) {
    if (owner === slotId) leafToWorkspace.delete(tabId);
  }
  workspaces.delete(slotId);
  workspaceTick.value++;
}

/** Slot id of the workspace owning `tabId` as a leaf, or undefined. */
export function workspaceOfLeaf(tabId: number): number | undefined {
  return leafToWorkspace.get(tabId);
}

export function isWorkspaceSlot(slotId: number): boolean {
  return workspaces.has(slotId);
}

// Cross-component flag: a tab-bar drag that ends inside the terminal area is
// "consumed" into a workspace; TabBar.onDragEnd must then skip its tear-off.
let consumed = false;
export function markTabConsumed(): void {
  consumed = true;
}
export function takeTabConsumed(): boolean {
  const v = consumed;
  consumed = false;
  return v;
}
export function resetTabConsumed(): void {
  consumed = false;
}
