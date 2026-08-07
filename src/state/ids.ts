/**
 * Branded id types.
 *
 * Three different kinds of number are called "tab id" in this app, and they
 * used to be interchangeable `number`s distinguished only by a sign
 * convention that every call site had to remember:
 *
 *   - **`PaneId`** — a workspace *leaf*. Either a backend PTY id (positive,
 *     from the Rust registry's monotonic counter) or a frontend panel leaf
 *     (negative, from `allocPanelLeafId`).
 *   - **`SlotId`** — a tab-bar slot, which is also its workspace's registry
 *     key. Always frontend-allocated, never a backend id.
 *
 * Both negatives come from the same counter, so a slot id and a panel leaf id
 * are two different negative numbers that look identical. Passing one where
 * the other belongs type-checked cleanly and then did nothing at runtime — the
 * map lookup returned `undefined` and the caller no-opped. `workspaceOfLeaf`
 * and `owningTabId` were the sharpest edge: same signature, overlapping
 * meaning, different answers.
 *
 * These brands are erased at runtime (they're `number`), so there is no cost.
 * A branded id is usable anywhere a `number` is; the compiler only stops the
 * reverse. Ids enter the branded world at three boundaries and nowhere else:
 * the IPC payload types in `ipc.ts` (where the backend's `u64` arrives),
 * `allocSlotId`/`allocPanelLeafId` in `panels.ts`, and reading an id back out
 * of a DOM dataset. Anywhere else, thread the type through instead of casting
 * — a cast in the middle of a call chain is the bug this exists to prevent.
 *
 * Two crossings are legitimate and are spelled out where they happen: an
 * SFTP-only workspace's pooled SSH connection is registered on the backend
 * under its *slot* id (so `handleExit` and `owningTabId` accept both), and a
 * drag's `draggedId` is a slot for a whole-tab drag and a pane for a pane
 * drag.
 */

declare const paneBrand: unique symbol;
declare const slotBrand: unique symbol;

export type PaneId = number & { readonly [paneBrand]: true };
export type SlotId = number & { readonly [slotBrand]: true };

