import { describe, expect, it } from "vitest";

import type { PaneId } from "./ids";
import { isPanelLeafId } from "./panels";
import {
  buildWorkspaceFromWire,
  toWireNode,
  wireTermIds,
  type WireNode,
} from "./wire";
import {
  collectLeaves,
  findLeafByTabId,
  makeLeaf,
  makeSplit,
  type TabOrigin,
  type WorkspaceNode,
} from "./workspace";

// Ids are minted here rather than threaded in from a real source, so the
// brands are applied at the fixture boundary.
const pane = (n: number) => n as PaneId;
const term = (id: number): TabOrigin => ({ kind: "terminal", title: `Terminal ${id}` });
const ssh = (host: string): TabOrigin => ({
  kind: "ssh",
  title: host,
  hostLabel: host,
  hostId: 7,
});
const filesPanel = (seedPath: string): TabOrigin => ({
  kind: "panel",
  title: "Files",
  panel: { kind: "files", seedPath },
});

/** Stand-in for the receiver's `originFromHydrateInfo` lookup. */
const resolve = (tabId: PaneId): TabOrigin => term(tabId);

/** Send a tree over the wire and rebuild it, as the two windows would. */
function roundTrip(root: WorkspaceNode, focusedTabId: PaneId) {
  const wire = JSON.parse(JSON.stringify(toWireNode(root, focusedTabId))) as WireNode;
  const focusRef = { id: pane(-1) };
  const rebuilt = buildWorkspaceFromWire(wire, resolve, focusRef);
  return { wire, rebuilt, focusedTabId: focusRef.id };
}

describe("wireTermIds", () => {
  it("lists backend ids left to right and ignores panels", () => {
    const root = makeSplit(
      "h",
      makeLeaf(pane(1), term(1)),
      makeSplit("v", makeLeaf(pane(-4), filesPanel("/tmp")), makeLeaf(pane(2), term(2))),
    );
    expect(wireTermIds(toWireNode(root, pane(1)))).toEqual([1, 2]);
  });

  it("is empty for an all-panel tree", () => {
    const root = makeSplit("h", makeLeaf(pane(-1), filesPanel("/a")), makeLeaf(pane(-2), filesPanel("/b")));
    expect(wireTermIds(toWireNode(root, pane(-1)))).toEqual([]);
  });
});

describe("round trip", () => {
  it("preserves a single terminal leaf", () => {
    const { rebuilt } = roundTrip(makeLeaf(pane(5), term(5)), pane(5));
    expect(rebuilt.kind).toBe("leaf");
    expect(collectLeaves(rebuilt).map((l) => l.tabId)).toEqual([5]);
  });

  it("preserves split direction, ratio and leaf order", () => {
    const root = makeSplit("v", makeLeaf(pane(1), term(1)), makeLeaf(pane(2), term(2)), 0.3);
    const { rebuilt } = roundTrip(root, pane(1));
    expect(rebuilt.kind).toBe("split");
    if (rebuilt.kind !== "split") return;
    expect(rebuilt.dir).toBe("v");
    expect(rebuilt.ratio).toBeCloseTo(0.3);
    expect(collectLeaves(rebuilt).map((l) => l.tabId)).toEqual([1, 2]);
  });

  it("preserves a deep mixed tree's shape", () => {
    const root = makeSplit(
      "h",
      makeSplit("v", makeLeaf(pane(1), term(1)), makeLeaf(pane(-9), filesPanel("/srv")), 0.25),
      makeLeaf(pane(2), ssh("web01")),
      0.6,
    );
    const { rebuilt } = roundTrip(root, pane(2));
    expect(collectLeaves(rebuilt)).toHaveLength(3);
    // Terminal ids survive verbatim; the panel got a fresh negative id.
    const ids = collectLeaves(rebuilt).map((l) => l.tabId);
    expect(ids.filter((id) => id > 0)).toEqual([1, 2]);
    expect(ids.filter(isPanelLeafId)).toHaveLength(1);
  });

  it("carries a panel by value and gives it a fresh local id", () => {
    const root = makeLeaf(pane(-3), filesPanel("/var/log"));
    const { rebuilt } = roundTrip(root, pane(-3));
    expect(rebuilt.kind).toBe("leaf");
    if (rebuilt.kind !== "leaf") return;
    expect(rebuilt.origin.panel).toEqual({ kind: "files", seedPath: "/var/log" });
    expect(rebuilt.origin.title).toBe("Files");
    // Leaf ids are only unique within the process that allocated them, so the
    // arriving pane must NOT reuse the sender's id.
    expect(rebuilt.tabId).not.toBe(-3);
    expect(isPanelLeafId(rebuilt.tabId)).toBe(true);
  });

  it("does not alias the sender's PanelDesc object", () => {
    const origin = filesPanel("/original");
    const { rebuilt } = roundTrip(makeLeaf(pane(-3), origin), pane(-3));
    if (rebuilt.kind !== "leaf") throw new Error("expected a leaf");
    rebuilt.origin.panel!.seedPath = "/mutated";
    expect(origin.panel!.seedPath).toBe("/original");
  });

  it("re-derives the focused id for a terminal leaf", () => {
    const root = makeSplit("h", makeLeaf(pane(1), term(1)), makeLeaf(pane(2), term(2)));
    expect(roundTrip(root, pane(2)).focusedTabId).toBe(2);
  });

  it("re-derives the focused id for a panel leaf whose id changed", () => {
    const root = makeSplit("h", makeLeaf(pane(1), term(1)), makeLeaf(pane(-8), filesPanel("/x")));
    const { rebuilt, focusedTabId } = roundTrip(root, pane(-8));
    expect(focusedTabId).not.toBe(-8);
    // Whatever the new id is, it must name the rebuilt panel leaf.
    const leaf = findLeafByTabId(rebuilt, focusedTabId);
    expect(leaf?.origin.kind).toBe("panel");
  });

  it("leaves the focus sentinel alone when nothing is marked focused", () => {
    const root = makeSplit("h", makeLeaf(pane(1), term(1)), makeLeaf(pane(2), term(2)));
    // 99 is in neither leaf, so no leaf marks itself.
    expect(roundTrip(root, pane(99)).focusedTabId).toBe(-1);
  });

  it("falls back to a plain origin when a leaf's attach info is missing", () => {
    // The receiver's resolver is what decides this; a tree must still assemble
    // rather than throw mid-way and strand the panes that did arrive.
    const wire = toWireNode(makeLeaf(pane(4), ssh("db01")), pane(4));
    const rebuilt = buildWorkspaceFromWire(
      wire,
      (id) => ({ kind: "terminal", title: `Terminal ${id}` }),
      { id: pane(-1) },
    );
    expect(rebuilt.kind).toBe("leaf");
    if (rebuilt.kind !== "leaf") return;
    expect(rebuilt.origin.title).toBe("Terminal 4");
  });
});
