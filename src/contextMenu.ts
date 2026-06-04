import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";

export interface CtxItem {
  text: string;
  action: () => void;
  enabled?: boolean;
}

/**
 * Pop up a native OS context menu at the current cursor position.
 * `null` entries become separators. Native menus can't tint items (e.g. red
 * for "Delete"), so destructive items are conventionally placed last after a
 * separator.
 */
export async function popupMenu(items: (CtxItem | null)[]): Promise<void> {
  const built = await Promise.all(
    items.map((it) =>
      it === null
        ? PredefinedMenuItem.new({ item: "Separator" })
        : MenuItem.new({
            text: it.text,
            enabled: it.enabled ?? true,
            action: it.action,
          }),
    ),
  );
  const menu = await Menu.new({ items: built });
  await menu.popup();
}
