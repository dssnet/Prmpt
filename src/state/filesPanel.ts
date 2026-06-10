/**
 * Files-panel column state, hoisted out of the component so the dual-pane
 * layout survives the panel unmounting (switching to another tab swaps the
 * whole panel out of the DOM). One slot per panel kind + hosting tab, so each
 * tab keeps its own single/dual layout.
 */
import { ref, type Ref } from "vue";

/** What a column shows: an SSH connection's SFTP browser (by tab id) or the
 *  local file browser. */
export type PanelSource = number | "local";

export interface PanelColumns {
  left: Ref<PanelSource>;
  right: Ref<PanelSource | null>;
}

const columnsByKey = new Map<string, PanelColumns>();

/** Column state for one panel instance. Created on first use, seeded to the
 *  hosting tab's own connection (SSH panels) or local files. Session-only;
 *  tab ids are never reused, so entries for closed tabs just sit unused. */
export function getPanelColumns(
  kind: "ssh" | "terminal",
  tabId: number,
): PanelColumns {
  const key = `${kind}:${tabId}`;
  let cols = columnsByKey.get(key);
  if (!cols) {
    cols = {
      left: ref<PanelSource>(kind === "ssh" ? tabId : "local"),
      right: ref<PanelSource | null>(null),
    };
    columnsByKey.set(key, cols);
  }
  return cols;
}

/** Last visited directory + nav history per browser, so a remount (the
 *  browsers unmount on every tab switch) resumes where the user left off
 *  instead of starting over at the home directory. SFTP browsers are keyed
 *  by connection tab id (`sftp:<id>`); the local browser shares one slot
 *  (`local`) — its cwd already persists across target-tab changes while
 *  mounted, so the memory mirrors that. Session-only; tab ids are never
 *  reused, so stale SFTP entries just sit unused. */
export interface BrowserLocation {
  cwd: string;
  back: string[];
  forward: string[];
}

export const browserLocations = new Map<string, BrowserLocation>();
