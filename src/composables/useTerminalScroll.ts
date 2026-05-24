import { computed, type ComputedRef } from "vue";

import { scrollTab } from "../ipc";
import { snapshotFor, useTabs } from "../state/tabs";

export interface ScrollAdapter {
  position: ComputedRef<number>;
  range: ComputedRef<number>;
  viewportSize: ComputedRef<number>;
  onScrollTo: (pos: number) => void;
  onPageBy: (dir: -1 | 1) => void;
}

/**
 * Bind a `<Scrollbar>` to a terminal tab's scrollback. Reads the latest
 * `RenderPayload` for the tab through `snapshotFor` — the `renderSeq` tick
 * inside `useTabs` is what makes the computeds re-evaluate per frame.
 *
 * Units are rows. `position` is `viewport_top` (rows from top of scrollback
 * to viewport row 0), `range` is the number of rows the viewport can travel,
 * and `viewportSize` is the visible row count.
 */
export function useTerminalScroll(tabId: number): ScrollAdapter {
  // Touching `renderSeq` inside the computeds wires Vue reactivity into the
  // imperative `snapshots` Map. Without it, `snapshotFor()` would only be
  // re-read on unrelated reactive deps.
  const { renderSeq } = useTabs();

  function snap() {
    void renderSeq.value;
    return snapshotFor(tabId);
  }

  const position = computed(() => snap()?.viewport_top ?? 0);
  const viewportSize = computed(() => snap()?.rows ?? 0);
  const range = computed(() => {
    const s = snap();
    if (!s) return 0;
    return Math.max(0, s.scrollback_total - s.rows);
  });

  function onScrollTo(pos: number): void {
    const s = snap();
    if (!s) return;
    const delta = pos - s.viewport_top;
    if (delta === 0) return;
    void scrollTab(tabId, { kind: "delta", delta });
  }

  function onPageBy(dir: -1 | 1): void {
    void scrollTab(tabId, { kind: dir < 0 ? "page_up" : "page_down" });
  }

  return { position, range, viewportSize, onScrollTo, onPageBy };
}
