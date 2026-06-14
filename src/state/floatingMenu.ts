/**
 * A single in-webview context menu (cursor-positioned, with optional one-level
 * submenus and per-item hover callbacks). Unlike the native `popupMenu`
 * (src/contextMenu.ts), this one runs inside the webview, so a submenu item can
 * fire `onHover` / `onLeave` — used to highlight the target terminal pane while
 * choosing where to send a `cd` / insert-path. Rendered once by
 * `components/FloatingMenu.vue` (mounted in App.vue) off the reactive model
 * below; opened via `openFloatingMenu`.
 */
import { ref } from "vue";

export interface FloatingMenuItem {
  text: string;
  /** Leaf action. Omit when `submenu` is set. */
  action?: () => void;
  /** One level of nested items (e.g. a terminal list). */
  submenu?: FloatingMenuItem[];
  /** Tint the item as destructive (e.g. Delete). */
  danger?: boolean;
  disabled?: boolean;
  /** Fired when the pointer enters / leaves this item (submenu leaves too). */
  onHover?: () => void;
  onLeave?: () => void;
}

/** `null` entries render as separators. */
export type FloatingMenuEntry = FloatingMenuItem | null;

export interface FloatingMenuModel {
  x: number;
  y: number;
  items: FloatingMenuEntry[];
}

export const floatingMenu = ref<FloatingMenuModel | null>(null);

export function openFloatingMenu(
  x: number,
  y: number,
  items: FloatingMenuEntry[],
): void {
  floatingMenu.value = { x, y, items };
}

export function closeFloatingMenu(): void {
  floatingMenu.value = null;
}
