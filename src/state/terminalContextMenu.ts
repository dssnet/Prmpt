/**
 * The terminal right-click menu (Copy / Paste / optional Copy Link), rendered
 * as an in-webview `FloatingMenu` (state/floatingMenu.ts). This replaces the
 * former native popup driven by the `show_context_menu` Tauri command — every
 * menu in the app now goes through our own UI components.
 *
 * On a link the menu grows a "Copy Link" item; the URL is hit-tested here and
 * remembered via `setContextLink`, then read back by `copyContextLink`.
 */
import { copyContextLink, setContextLink } from "./links";
import { openFloatingMenu, type FloatingMenuEntry } from "./floatingMenu";
import {
  copyCurrentSelection,
  hasSelection,
  linkAtEvent,
  pasteFromClipboard,
} from "./terminal";

export function openTerminalContextMenu(e: MouseEvent): void {
  const link = linkAtEvent(e);
  setContextLink(link?.url ?? null);

  const items: FloatingMenuEntry[] = [];
  if (link) {
    items.push({ text: "Copy Link", action: () => copyContextLink() });
    items.push(null);
  }
  items.push({
    text: "Copy",
    disabled: !hasSelection(),
    action: () => copyCurrentSelection(),
  });
  items.push({ text: "Paste", action: () => void pasteFromClipboard() });

  openFloatingMenu(e.clientX, e.clientY, items);
}
