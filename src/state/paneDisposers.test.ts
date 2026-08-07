import { describe, expect, it, vi } from "vitest";

import { disposeLeafState, onLeafDisposed } from "./paneDisposers";

describe("pane disposer registry", () => {
  it("runs every registered disposer with the leaf id", () => {
    const a = vi.fn();
    const b = vi.fn();
    onLeafDisposed(a);
    onLeafDisposed(b);
    disposeLeafState(42);
    expect(a).toHaveBeenCalledWith(42);
    expect(b).toHaveBeenCalledWith(42);
  });

  it("keeps going when one disposer throws", () => {
    // One misbehaving side table must not abort a teardown half-done and
    // strand the rest — that is the failure mode the hand-threaded cleanup
    // had, one path at a time.
    const boom = vi.fn(() => {
      throw new Error("nope");
    });
    const after = vi.fn();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    onLeafDisposed(boom);
    onLeafDisposed(after);
    expect(() => disposeLeafState(7)).not.toThrow();
    expect(after).toHaveBeenCalledWith(7);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("is safe to call twice for the same pane", () => {
    const seen: number[] = [];
    onLeafDisposed((id) => seen.push(id));
    disposeLeafState(3);
    disposeLeafState(3);
    expect(seen.filter((id) => id === 3)).toHaveLength(2);
  });
});
