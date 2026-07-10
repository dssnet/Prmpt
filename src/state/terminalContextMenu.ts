/**
 * The terminal right-click menu (Copy / Paste / optional Copy Link / Split …),
 * rendered as an in-webview `FloatingMenu` (state/floatingMenu.ts). This
 * replaces the former native popup driven by the `show_context_menu` Tauri
 * command — every menu in the app now goes through our own UI components.
 *
 * On a link the menu grows a "Copy Link" item; the URL is hit-tested here and
 * remembered via `setContextLink`, then read back by `copyContextLink`.
 *
 * The Split items split the pane that was right-clicked (not the focused
 * one), and the new terminal inherits that pane's working directory when it's
 * knowable (local shells; SSH panes and dead shells fall back to the default).
 */
import {
  ClipboardPaste,
  Copy,
  Link,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
} from "lucide-vue-next";

import { terminalCwd } from "../ipc";
import { copyContextLink, setContextLink } from "./links";
import { openFloatingMenu, type FloatingMenuEntry } from "./floatingMenu";
import {
  computeDims,
  copyCurrentSelection,
  focusCanvas,
  getCellMetrics,
  hasSelection,
  inputTargetTabId,
  linkAtEvent,
  pasteFromClipboard,
  pointerCell,
} from "./terminal";
import { dropTabIntoTarget, spawnTerminal, useTabs } from "./tabs";
import type { SplitDir } from "./workspace";

const { active } = useTabs();

async function splitPane(
  slotId: number,
  paneId: number,
  dir: SplitDir,
  placeNewFirst: boolean,
): Promise<void> {
  const cwd = (await terminalCwd(paneId).catch(() => null)) ?? undefined;
  const { cellWidthPx, cellHeightPx, dpr } = getCellMetrics();
  const dims = computeDims();
  const newId = await spawnTerminal({
    cols: dims.cols,
    rows: dims.rows,
    cellWidthPx: Math.round(cellWidthPx * dpr),
    cellHeightPx: Math.round(cellHeightPx * dpr),
    cwd,
  });
  dropTabIntoTarget(newId, slotId, paneId, dir, placeNewFirst);
  focusCanvas();
}

export function openTerminalContextMenu(e: MouseEvent): void {
  const link = linkAtEvent(e);
  setContextLink(link?.url ?? null);

  // Paste and Split target the pane under the cursor (fall back to the
  // focused pane when the click landed on host padding between grids).
  const paneId = pointerCell(e)?.tabId ?? inputTargetTabId();

  const items: FloatingMenuEntry[] = [];
  if (link) {
    items.push({ text: "Copy Link", icon: Link, action: () => copyContextLink() });
    items.push(null);
  }
  items.push({
    text: "Copy",
    icon: Copy,
    disabled: !hasSelection(),
    action: () => copyCurrentSelection(),
  });
  items.push({
    text: "Paste",
    icon: ClipboardPaste,
    action: () => void pasteFromClipboard(paneId ?? undefined),
  });

  const slotId = active.value?.id;
  if (paneId != null && slotId != null) {
    const splits: Array<[string, typeof PanelRight, SplitDir, boolean]> = [
      ["Split Right", PanelRight, "h", false],
      ["Split Left", PanelLeft, "h", true],
      ["Split Down", PanelBottom, "v", false],
      ["Split Up", PanelTop, "v", true],
    ];
    items.push(null);
    for (const [text, icon, dir, first] of splits) {
      items.push({ text, icon, action: () => void splitPane(slotId, paneId, dir, first) });
    }
  }

  openFloatingMenu(e.clientX, e.clientY, items);
}
