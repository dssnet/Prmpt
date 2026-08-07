/**
 * The cross-window wire form of a pane tree.
 *
 * When a tab or a pane leaves this window, its workspace subtree has to
 * survive a trip through another process. Two things don't travel:
 *
 *   - **Panel leaf ids** are process-local (`allocPanelLeafId`), so a panel
 *     rides *by value* — its `PanelDesc` and title — and gets a fresh local id
 *     on arrival. Terminal leaves ride as just their backend id; the receiver
 *     resolves each one's origin from the attach info it gets alongside.
 *   - **`focusedTabId`** names an id that may not exist on the other side, so
 *     the focused leaf marks itself instead and the receiver re-derives the id
 *     while rebuilding.
 *
 * This module is deliberately dependency-free apart from the two pure modules
 * it builds trees out of (`workspace`, `panels`) — no Tauri, no IPC, no Vue
 * state. That is what makes it unit-testable, and it is why the terminal-leaf
 * origin arrives as a callback rather than as an import of `tabs.ts`.
 */

import type { PaneId } from "./ids";
import { allocPanelLeafId, type PanelDesc } from "./panels";
import {
  isPanelLeaf,
  makeLeaf,
  makeSplit,
  type SplitDir,
  type TabOrigin,
  type WorkspaceNode,
} from "./workspace";

/** Split dirs/ratios are explicit here (not re-derived from cursor geometry
 *  on arrival), so a multi-pane tree lands laid out the way it left. */
export type WireNode =
  | { kind: "term"; tabId: PaneId; focused: boolean }
  | { kind: "panel"; desc: PanelDesc; title: string; focused: boolean }
  | { kind: "split"; dir: SplitDir; ratio: number; a: WireNode; b: WireNode };

/** TabState-level fields that only apply when a move is a whole tab (not a
 *  lone pane peeled off a still-live workspace) — SSH host identity rides on
 *  the tab, not on any one leaf's `TabOrigin`. */
export interface WholeTabMeta {
  title: string;
  hostLabel?: string;
  hostId?: number;
  disableSftp?: boolean;
}

/** A move released over another window. `x`/`y` are null for an append-only
 *  drop (tear-off into a new window, or a fallback attach with no resolved
 *  hover point); otherwise the receiver resolves them to a bar slot or a pane
 *  split target, same as a local drop. */
export interface CrossTreeDropPayload {
  x: number | null;
  y: number | null;
  tree: WireNode;
  termIds: PaneId[];
  whole?: WholeTabMeta;
}

export function toWireNode(node: WorkspaceNode, focusedTabId: PaneId): WireNode {
  if (node.kind === "split") {
    return {
      kind: "split",
      dir: node.dir,
      ratio: node.ratio,
      a: toWireNode(node.a, focusedTabId),
      b: toWireNode(node.b, focusedTabId),
    };
  }
  const focused = node.tabId === focusedTabId;
  return isPanelLeaf(node)
    ? {
        kind: "panel",
        desc: { ...node.origin.panel! },
        title: node.origin.title,
        focused,
      }
    : { kind: "term", tabId: node.tabId, focused };
}

/** Backend ids named by the tree, left to right — the set the receiver must
 *  see attached before it can assemble the tree. */
export function wireTermIds(node: WireNode, out: PaneId[] = []): PaneId[] {
  if (node.kind === "split") {
    wireTermIds(node.a, out);
    wireTermIds(node.b, out);
  } else if (node.kind === "term") {
    out.push(node.tabId);
  }
  return out;
}

/** Rebuild a workspace tree from its wire shape. `resolveTerm` supplies each
 *  terminal leaf's origin (the caller knows how to turn attach info into a
 *  `TabOrigin`); panel leaves get a fresh local id. `focusRef.id` is set to
 *  the rebuilt id of whichever leaf was marked focused — leave it at a
 *  sentinel the caller recognizes, since a tree need not mark one. */
export function buildWorkspaceFromWire(
  node: WireNode,
  resolveTerm: (tabId: PaneId) => TabOrigin,
  focusRef: { id: PaneId },
): WorkspaceNode {
  if (node.kind === "split") {
    return makeSplit(
      node.dir,
      buildWorkspaceFromWire(node.a, resolveTerm, focusRef),
      buildWorkspaceFromWire(node.b, resolveTerm, focusRef),
      node.ratio,
    );
  }
  const leaf =
    node.kind === "panel"
      ? makeLeaf(allocPanelLeafId(), {
          kind: "panel",
          title: node.title,
          panel: node.desc,
        })
      : makeLeaf(node.tabId, resolveTerm(node.tabId));
  if (node.focused) focusRef.id = leaf.tabId;
  return leaf;
}
