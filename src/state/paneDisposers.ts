/**
 * One teardown hook for everything keyed by a pane (leaf) id.
 *
 * The app accumulated a side table per pane feature — render snapshots, SSH
 * reconnect flags, text selections, SFTP consumers, row-text caches, file
 * browser columns — and every one of the five "make a pane go away" paths had
 * to remember to clear every one of them by hand. They didn't: closing a
 * multi-pane SSH tab was the one path that forgot `sshReconnecting`, and two
 * tables had given up on the hand-threading altogether and grown their own
 * garbage collectors instead (selections swept itself against the snapshot
 * map; the row-text cache cleared *everything* past 16 entries).
 *
 * Now a table registers a disposer once, here, and the close paths call
 * `disposeLeafState` — so adding a per-pane feature is one registration, not
 * an audit of every close path.
 *
 * Disposers must be idempotent: a pane can be disposed more than once (e.g. a
 * PTY exit racing a user close), and re-disposal must be a no-op, not an
 * error. They must not throw — one misbehaving table cannot be allowed to
 * abort the rest of a teardown.
 */

type LeafDisposer = (leafId: number) => void;

const disposers: LeafDisposer[] = [];

/** Register a per-pane teardown step. Call at module scope, once. */
export function onLeafDisposed(fn: LeafDisposer): void {
  disposers.push(fn);
}

/** Drop every piece of per-pane state held for `leafId`. Backend-agnostic:
 *  whether the pane's PTY is being closed or has merely moved to another
 *  window, this window is done with it either way. */
export function disposeLeafState(leafId: number): void {
  for (const dispose of disposers) {
    try {
      dispose(leafId);
    } catch (e) {
      console.error("pane disposer failed:", e);
    }
  }
}
