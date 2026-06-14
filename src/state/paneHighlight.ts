/**
 * Which workspace terminal pane should render a highlight border. Set while
 * hovering a terminal entry in the file browser's "cd here / insert path"
 * submenu, so the user sees which pane the command will land in. Read by
 * TerminalView's pane overlays. Null when nothing is hovered.
 */
import { ref } from "vue";

export const highlightedPaneId = ref<number | null>(null);

export function setHighlightedPane(id: number): void {
  highlightedPaneId.value = id;
}

export function clearHighlightedPane(): void {
  highlightedPaneId.value = null;
}
