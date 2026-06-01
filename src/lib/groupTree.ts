/**
 * Pure helpers for the SSH host group hierarchy. No Vue or DB deps — these
 * turn the flat `ssh_groups` rows (linked by `parent_id`) into a tree, compute
 * the descendant set used for recursive host filtering, and produce an indented
 * option list for the host-editor group picker.
 */

import type { SshGroupRow } from "../db";

export interface GroupNode {
  group: SshGroupRow;
  children: GroupNode[];
}

/** Build a forest from flat rows. A row whose `parent_id` is NULL — or points
 *  at a group that doesn't exist (dangling, shouldn't happen given the reparent
 *  cascade in `deleteGroup`) — becomes a top-level node. Children of each node
 *  keep the `ORDER BY label` ordering of the input rows. */
export function buildGroupTree(rows: SshGroupRow[]): GroupNode[] {
  const byId = new Map<number, GroupNode>();
  for (const group of rows) byId.set(group.id, { group, children: [] });

  const roots: GroupNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.group.parent_id;
    const parent = parentId != null ? byId.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** The id of `rootId` plus every group nested beneath it (any depth). Used to
 *  filter hosts when a parent group is selected — it shows its own hosts and
 *  all descendant subgroup hosts. */
export function descendantGroupIds(
  rows: SshGroupRow[],
  rootId: number,
): Set<number> {
  const childrenOf = new Map<number, number[]>();
  for (const g of rows) {
    if (g.parent_id == null) continue;
    const list = childrenOf.get(g.parent_id);
    if (list) list.push(g.id);
    else childrenOf.set(g.parent_id, [g.id]);
  }

  const ids = new Set<number>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (ids.has(id)) continue; // guard against accidental cycles
    ids.add(id);
    const children = childrenOf.get(id);
    if (children) stack.push(...children);
  }
  return ids;
}

/** Ids of every group that is effectively concealed: either flagged `hidden`
 *  itself, or nested (any depth) beneath a group that is. Used to drop hidden
 *  groups and their hosts from the view while the sidebar is locked. */
export function concealedGroupIds(rows: SshGroupRow[]): Set<number> {
  const byId = new Map<number, SshGroupRow>();
  for (const g of rows) byId.set(g.id, g);

  const concealed = new Set<number>();
  const isConcealed = (g: SshGroupRow): boolean => {
    let cur: SshGroupRow | undefined = g;
    const seen = new Set<number>();
    while (cur && !seen.has(cur.id)) {
      if (cur.hidden) return true;
      seen.add(cur.id);
      cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
    }
    return false;
  };

  for (const g of rows) if (isConcealed(g)) concealed.add(g.id);
  return concealed;
}

export interface GroupOption {
  value: string;
  label: string;
}

/** Flatten the tree to a depth-first option list with indentation prefixes,
 *  so subgroups read as nested inside a flat `DropdownMenu`. `value` is the
 *  stringified group id (matches the host-editor's string-valued form fields). */
export function flattenForPicker(rows: SshGroupRow[]): GroupOption[] {
  const out: GroupOption[] = [];
  const walk = (nodes: GroupNode[], depth: number) => {
    for (const node of nodes) {
      const prefix = depth > 0 ? `${"— ".repeat(depth)}` : "";
      out.push({ value: String(node.group.id), label: `${prefix}${node.group.label}` });
      walk(node.children, depth + 1);
    }
  };
  walk(buildGroupTree(rows), 0);
  return out;
}
