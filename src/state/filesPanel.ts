/**
 * Files-panel source state, hoisted out of the component so the chosen
 * source survives the panel unmounting (switching to another tab swaps the
 * whole panel out of the DOM). One slot per panel instance. Side-by-side
 * browsing is done by tiling two file panels in the workspace, so each panel
 * shows a single source.
 */
import { ref, type Ref } from "vue";

/** What a panel shows: an SSH connection's SFTP browser (by tab id) or the
 *  local file browser. */
export type PanelSource = number | "local";

export interface PanelColumns {
  source: Ref<PanelSource>;
}

const columnsByKey = new Map<string, PanelColumns>();

/** Source state for one panel instance (keyed by the panel pane's stable
 *  identity), seeded on first use. Session-only; pane ids are never reused,
 *  so entries for closed panes just sit unused. */
export function getPanelColumns(key: string, seed: PanelSource): PanelColumns {
  let cols = columnsByKey.get(key);
  if (!cols) {
    cols = { source: ref<PanelSource>(seed) };
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
