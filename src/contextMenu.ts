import type { Component } from "vue";

import { openFloatingMenu, type FloatingMenuEntry } from "./state/floatingMenu";

export interface CtxItem {
  text: string;
  action: () => void;
  enabled?: boolean;
  /** Optional leading icon (a lucide-vue-next component). */
  icon?: Component;
  /** Tint the item as destructive (e.g. Delete). */
  danger?: boolean;
}

// The cursor position of the last pointer interaction, so a `popupMenu` opened
// from a click/contextmenu handler (which doesn't thread the event through)
// still anchors at the cursor — the same place the old native popup appeared.
let lastPointer = { x: 0, y: 0 };
function trackPointer(e: PointerEvent | MouseEvent): void {
  lastPointer = { x: e.clientX, y: e.clientY };
}
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", trackPointer, true);
  window.addEventListener("contextmenu", trackPointer, true);
}

/**
 * Pop up a flat context menu at the current cursor position using our own
 * in-webview `FloatingMenu` (no native OS menu). `null` entries become
 * separators; destructive items are conventionally placed last after a
 * separator and can set `danger` for a red tint.
 */
export function popupMenu(items: (CtxItem | null)[]): void {
  const entries: FloatingMenuEntry[] = items.map((it) =>
    it === null
      ? null
      : {
          text: it.text,
          icon: it.icon,
          action: it.action,
          disabled: it.enabled === false,
          danger: it.danger,
        },
  );
  openFloatingMenu(lastPointer.x, lastPointer.y, entries);
}
