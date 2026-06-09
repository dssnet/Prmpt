/**
 * Files-panel column state, hoisted out of the component so the dual-pane
 * layout survives the panel unmounting (switching to another tab swaps the
 * whole panel out of the DOM). One slot per panel kind: the SSH-tab panel and
 * the terminal-tab panel keep independent layouts.
 */
import { ref, type Ref } from "vue";

/** What a column shows: an SSH connection's SFTP browser (by tab id) or the
 *  local file browser. */
export type PanelSource = number | "local";

export interface PanelColumns {
  left: Ref<PanelSource>;
  right: Ref<PanelSource | null>;
  /** False until the first FilesPanel mount seeds `left` for this kind. */
  seeded: boolean;
}

export const panelColumns: Record<"ssh" | "terminal", PanelColumns> = {
  ssh: { left: ref<PanelSource>("local"), right: ref<PanelSource | null>(null), seeded: false },
  terminal: {
    left: ref<PanelSource>("local"),
    right: ref<PanelSource | null>(null),
    seeded: false,
  },
};
