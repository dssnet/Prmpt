import { beforeEach, describe, expect, it } from "vitest";

import type { PaneId, SlotId } from "./ids";
import {
  collectLeaves,
  collectTerminalLeaves,
  deleteWorkspace,
  findLeafByTabId,
  getWorkspace,
  GUTTER,
  layout,
  makeLeaf,
  makeSplit,
  removeLeaf,
  setRatio,
  setWorkspace,
  splitLeaf,
  workspaceOfLeaf,
  type TabOrigin,
  type WorkspaceNode,
} from "./workspace";

const term = (title = "sh"): TabOrigin => ({ kind: "terminal", title });

// Ids are minted here rather than threaded in from a real source, so the
// brands are applied at the fixture boundary — the same rule production code
// follows: they enter the branded world at a boundary, once.
const pane = (n: number) => n as PaneId;
const slot = (n: number) => n as SlotId;
const panel = (): TabOrigin => ({
  kind: "panel",
  title: "Files",
  panel: { kind: "files" },
});

/** `a | b` (side by side), tab ids 1 and 2. */
function pair(): WorkspaceNode {
  return makeSplit("h", makeLeaf(pane(1), term()), makeLeaf(pane(2), term()));
}

describe("tree queries", () => {
  it("collects leaves left to right", () => {
    const root = makeSplit("v", pair(), makeLeaf(pane(3), term()));
    expect(collectLeaves(root).map((l) => l.tabId)).toEqual([1, 2, 3]);
  });

  it("separates terminal leaves from panel leaves", () => {
    const root = makeSplit("h", makeLeaf(pane(1), term()), makeLeaf(pane(-7), panel()));
    expect(collectLeaves(root)).toHaveLength(2);
    expect(collectTerminalLeaves(root).map((l) => l.tabId)).toEqual([1]);
  });

  it("finds a leaf by tab id and returns null for a stranger", () => {
    const root = pair();
    expect(findLeafByTabId(root, pane(2))?.tabId).toBe(2);
    expect(findLeafByTabId(root, pane(99))).toBeNull();
  });
});

describe("removeLeaf", () => {
  it("collapses the split into the surviving sibling", () => {
    const survivor = removeLeaf(pair(), pane(1));
    expect(survivor?.kind).toBe("leaf");
    expect(collectLeaves(survivor!).map((l) => l.tabId)).toEqual([2]);
  });

  it("returns null when the last leaf goes", () => {
    expect(removeLeaf(makeLeaf(pane(1), term()), pane(1))).toBeNull();
  });

  it("collapses only the split that lost a child", () => {
    // (1 | 2) stacked over 3 — removing 2 must leave (1 over 3), not flatten.
    const root = makeSplit("v", pair(), makeLeaf(pane(3), term()));
    const next = removeLeaf(root, pane(2))!;
    expect(next.kind).toBe("split");
    expect(collectLeaves(next).map((l) => l.tabId)).toEqual([1, 3]);
  });

  it("returns the identical node when the id isn't present", () => {
    const root = pair();
    expect(removeLeaf(root, pane(42))).toBe(root);
  });
});

describe("splitLeaf", () => {
  it("appends the new pane after the target by default", () => {
    const root = splitOnce(false);
    expect(collectLeaves(root).map((l) => l.tabId)).toEqual([1, 9]);
  });

  it("places the new pane first when asked", () => {
    const root = splitOnce(true);
    expect(collectLeaves(root).map((l) => l.tabId)).toEqual([9, 1]);
  });

  it("mirrors the ratio when the new pane goes first", () => {
    // Callers pass the fraction the NEW pane should get; placing it first
    // means the split's `ratio` (which describes child `a`) is that value,
    // and placing it second means the target keeps `ratio`.
    const first = splitOnce(true, 0.3);
    const second = splitOnce(false, 0.3);
    expect(first.kind === "split" && first.ratio).toBeCloseTo(0.7);
    expect(second.kind === "split" && second.ratio).toBeCloseTo(0.3);
  });

  it("leaves the tree untouched when the target isn't there", () => {
    const root = pair();
    expect(splitLeafOn(root, pane(42))).toBe(root);
  });

  it("grafts a whole subtree, not just a leaf", () => {
    const root = splitLeafOn(makeLeaf(pane(1), term()), pane(1), pair());
    expect(collectLeaves(root).map((l) => l.tabId)).toEqual([1, 1, 2]);
  });
});

describe("setRatio", () => {
  it("clamps into 0.05..0.95 so a pane can never vanish", () => {
    const root = pair() as Extract<WorkspaceNode, { kind: "split" }>;
    const wide = setRatio(root, root.id, 5) as typeof root;
    const thin = setRatio(root, root.id, -1) as typeof root;
    expect(wide.ratio).toBe(0.95);
    expect(thin.ratio).toBe(0.05);
  });

  it("returns the identical node for an unknown split id", () => {
    const root = pair();
    expect(setRatio(root, "nope", 0.2)).toBe(root);
  });
});

describe("layout", () => {
  it("gives a lone leaf the whole rect", () => {
    const { panes, dividers } = layout(makeLeaf(pane(1), term()), 0, 0, 800, 600);
    expect(panes).toEqual([{ tabId: 1, x: 0, y: 0, w: 800, h: 600 }]);
    expect(dividers).toEqual([]);
  });

  it("reserves exactly one gutter between two panes", () => {
    const { panes, dividers } = layout(pair(), 0, 0, 800, 600);
    const [a, b] = panes;
    expect(a.w + GUTTER + b.w).toBe(800);
    expect(b.x).toBe(a.w + GUTTER);
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toMatchObject({ dir: "h", x: a.w, w: GUTTER });
  });

  it("never emits a zero-sized pane in a cramped rect", () => {
    const { panes } = layout(pair(), 0, 0, 4, 4);
    for (const p of panes) {
      expect(p.w).toBeGreaterThanOrEqual(1);
      expect(p.h).toBeGreaterThanOrEqual(1);
    }
  });

  it("records a box for every split", () => {
    const root = makeSplit("v", pair(), makeLeaf(pane(3), term()));
    const { splitBoxes } = layout(root, 0, 0, 800, 600);
    expect(splitBoxes.size).toBe(2);
  });
});

describe("registry", () => {
  beforeEach(() => {
    for (const id of [slot(-1), slot(-2)]) deleteWorkspace(id);
  });

  it("indexes every leaf back to its slot", () => {
    setWorkspace(slot(-1), { root: pair(), focusedTabId: pane(1) });
    expect(workspaceOfLeaf(pane(1))).toBe(-1);
    expect(workspaceOfLeaf(pane(2))).toBe(-1);
    expect(workspaceOfLeaf(pane(3))).toBeUndefined();
  });

  it("drops stale leaf mappings when a workspace shrinks", () => {
    setWorkspace(slot(-1), { root: pair(), focusedTabId: pane(1) });
    setWorkspace(slot(-1), { root: makeLeaf(pane(1), term()), focusedTabId: pane(1) });
    expect(workspaceOfLeaf(pane(1))).toBe(-1);
    // 2 is gone from the tree; the reverse index must not still claim it.
    expect(workspaceOfLeaf(pane(2))).toBeUndefined();
  });

  it("does not touch another slot's leaves on delete", () => {
    setWorkspace(slot(-1), { root: makeLeaf(pane(1), term()), focusedTabId: pane(1) });
    setWorkspace(slot(-2), { root: makeLeaf(pane(2), term()), focusedTabId: pane(2) });
    deleteWorkspace(slot(-1));
    expect(getWorkspace(slot(-1))).toBeUndefined();
    expect(workspaceOfLeaf(pane(1))).toBeUndefined();
    expect(workspaceOfLeaf(pane(2))).toBe(-2);
  });
});

// --- helpers ---------------------------------------------------------------

function splitLeafOn(
  root: WorkspaceNode,
  targetTabId: PaneId,
  newNode: WorkspaceNode = makeLeaf(pane(9), term()),
): WorkspaceNode {
  return splitLeafImpl(root, targetTabId, newNode, false, 0.5);
}

function splitOnce(placeNewFirst: boolean, ratio = 0.5): WorkspaceNode {
  return splitLeafImpl(makeLeaf(pane(1), term()), pane(1), makeLeaf(pane(9), term()), placeNewFirst, ratio);
}

// Thin indirection so the helpers above read as intent rather than as a
// six-argument call repeated five times.
function splitLeafImpl(
  root: WorkspaceNode,
  targetTabId: PaneId,
  newNode: WorkspaceNode,
  placeNewFirst: boolean,
  ratio: number,
): WorkspaceNode {
  return splitLeaf(root, targetTabId, newNode, "h", placeNewFirst, ratio);
}
