/**
 * Saved workspace layouts — persist a workspace's tiling tree so it can be
 * reopened later (right-click a tab → "Save Workspace…"; reload from the tab
 * bar's + menu). Storage is the `saved_workspaces` table (device-local, not
 * synced — the tree references local `ssh_hosts.id`s).
 *
 * This module owns the *portable* serialization (an id-free `SavedNode` tree)
 * plus the DB CRUD. Rehydration — respawning backends / reconnecting hosts —
 * lives in `state/connect.ts::loadSavedWorkspace`, next to the other spawn
 * paths and `buildSshConnectConfig`.
 */

import { dbHandle } from "../db";
import { terminalCwd } from "../ipc";
import type { PanelKind } from "./panels";
import {
  collectTerminalLeaves,
  getWorkspace,
  type SplitDir,
  type TabOrigin,
  type WorkspaceNode,
} from "./workspace";

export interface SavedWorkspaceRow {
  id: number;
  label: string;
  created_at: string;
  updated_at: string;
}

/** Portable, id-free serialization of a workspace tree. Leaves keep only the
 *  `TabOrigin` (what to respawn); the volatile node ids and backend `tabId`s
 *  are regenerated on load. */
export interface SavedLeaf {
  kind: "leaf";
  origin: TabOrigin;
  /** Local terminal panes only: the folder the shell was in at save time, so
   *  it reopens there. Captured via `terminalCwd` (null for SSH panes). */
  cwd?: string;
}
export interface SavedSplit {
  kind: "split";
  dir: SplitDir;
  ratio: number;
  a: SavedNode;
  b: SavedNode;
}
export type SavedNode = SavedLeaf | SavedSplit;

/** Bump when the serialization shape changes incompatibly. */
const DOC_VERSION = 1;
interface SavedDoc {
  v: number;
  root: SavedNode;
}

/** Strip runtime-only fields from a leaf origin so the saved copy is portable.
 *  `seedTargetTabId` points at a live terminal that won't exist on reload — the
 *  restored panel just falls back to its focused pane. */
function cleanOrigin(origin: TabOrigin): TabOrigin {
  if (!origin.panel) return { ...origin };
  const { kind, seedHostId, seedPath } = origin.panel;
  const panel: { kind: PanelKind; seedHostId?: number; seedPath?: string } = { kind };
  if (seedHostId != null) panel.seedHostId = seedHostId;
  if (seedPath != null) panel.seedPath = seedPath;
  return { ...origin, panel };
}

function serializeNode(
  node: WorkspaceNode,
  cwdByTab: Map<number, string>,
): SavedNode {
  if (node.kind === "leaf") {
    const leaf: SavedLeaf = { kind: "leaf", origin: cleanOrigin(node.origin) };
    const cwd = cwdByTab.get(node.tabId);
    if (cwd) leaf.cwd = cwd;
    return leaf;
  }
  return {
    kind: "split",
    dir: node.dir,
    ratio: node.ratio,
    a: serializeNode(node.a, cwdByTab),
    b: serializeNode(node.b, cwdByTab),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Serialize the live workspace in `slotId` and store it under `label`.
 *  No-op if the slot has no workspace. Always inserts a new row. */
export async function saveWorkspaceLayout(slotId: number, label: string): Promise<void> {
  const ws = getWorkspace(slotId);
  if (!ws) return;
  // Snapshot each local terminal pane's current folder so it reopens there.
  // SSH panes have no local pid to query, so `terminalCwd` returns null.
  const cwdByTab = new Map<number, string>();
  await Promise.all(
    collectTerminalLeaves(ws.root).map(async (leaf) => {
      const cwd = await terminalCwd(leaf.tabId).catch(() => null);
      if (cwd) cwdByTab.set(leaf.tabId, cwd);
    }),
  );
  const doc: SavedDoc = { v: DOC_VERSION, root: serializeNode(ws.root, cwdByTab) };
  const ts = nowIso();
  await dbHandle().execute(
    `INSERT INTO saved_workspaces (label, tree_json, created_at, updated_at)
     VALUES ($1, $2, $3, $3)`,
    [label, JSON.stringify(doc), ts],
  );
}

export async function listSavedWorkspaces(): Promise<SavedWorkspaceRow[]> {
  return await dbHandle().select<SavedWorkspaceRow[]>(
    `SELECT id, label, created_at, updated_at
     FROM saved_workspaces
     ORDER BY label COLLATE NOCASE`,
  );
}

/** Fetch a saved workspace's label + deserialized tree, or null if missing /
 *  from an incompatible future format. */
export async function getSavedWorkspace(
  id: number,
): Promise<{ label: string; root: SavedNode } | null> {
  const rows = await dbHandle().select<{ label: string; tree_json: string }[]>(
    `SELECT label, tree_json FROM saved_workspaces WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  try {
    const doc = JSON.parse(row.tree_json) as SavedDoc;
    if (doc.v !== DOC_VERSION || !doc.root) return null;
    return { label: row.label, root: doc.root };
  } catch {
    return null;
  }
}

export async function deleteSavedWorkspace(id: number): Promise<void> {
  await dbHandle().execute(`DELETE FROM saved_workspaces WHERE id = $1`, [id]);
}
