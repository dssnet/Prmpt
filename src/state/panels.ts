/**
 * Generic panel system. A workspace leaf is either a terminal (a backend PTY
 * tab) or a *panel* — a frontend-only view (file browser, git, …) that tiles,
 * splits, resizes, rearranges and closes exactly like a terminal pane.
 *
 * Adding a new panel type:
 *   1. add its kind here (+ title / split ratio),
 *   2. register its component in TerminalView's PANEL_VIEWS map,
 *   3. give it an opener (an `openPanelPane("<kind>", …)` call site).
 * Everything else — layout, dividers, focus routing, drag-rearrange, close,
 * workspace collapse — is shared machinery keyed off the leaf.
 *
 * Panels are *self-contained*: each chooses what it operates on from inside
 * the panel (which server / folder / target terminal). The fields below are
 * only *seeds* — snapshots captured when the panel opens (e.g. from a
 * terminal pill); the panel's own pickers take over from there. Panels are
 * not tied to the lifetime of any one terminal.
 *
 * Panel leaves have no backend tab; they get frontend-allocated *negative*
 * ids so the whole tiling tree (which keys leaves by numeric `tabId`) works
 * unchanged. Backend tab ids are positive and HOME_TAB_ID is 0, so the sign
 * is the discriminator.
 */

import type { PaneId, SlotId } from "./ids";

export type PanelKind = "files" | "git";

/** What a panel leaf shows. Carried in the leaf's `TabOrigin.panel`. All
 *  fields beyond `kind` are open-time *seeds* — the panel's own controls take
 *  over once it's mounted. */
export interface PanelDesc {
  kind: PanelKind;
  /** files: seed the source to this saved host (local files otherwise). The
   *  browser acquires its own SFTP consumer for the host and releases it when
   *  the pane closes. */
  seedHostId?: number;
  /** Initial folder to show (local path). Local terminals seed this from
   *  their cwd; a host seeds the server via `seedHostId`, not a remote path. */
  seedPath?: string;
  /** files: initial cd / insert-path target terminal. */
  seedTargetTabId?: PaneId;
}

// Panel pane leaves AND workspace slot ids (every tab — see state/tabs.ts)
// draw from this one counter, which is what keeps the two globally unique.
// They are different *types* (see state/ids.ts) precisely because they look
// identical: both negative, both minted here.
let panelIdSeq = -1;

/** Allocate a frontend leaf id for a panel pane. */
export function allocPanelLeafId(): PaneId {
  return panelIdSeq-- as PaneId;
}

/** Allocate a tab-bar slot id (also its workspace's registry key). */
export function allocSlotId(): SlotId {
  return panelIdSeq-- as SlotId;
}

export function isPanelLeafId(id: PaneId): boolean {
  return id < 0;
}

export function panelTitle(desc: PanelDesc): string {
  switch (desc.kind) {
    case "git":
      return "Git";
    case "files":
      return "Files";
  }
}

/** Fraction of the split kept by the pane being split (the panel gets the
 *  rest) when a panel opens. */
export const PANEL_SPLIT_RATIO: Record<PanelKind, number> = {
  files: 0.5,
  git: 0.5,
};
