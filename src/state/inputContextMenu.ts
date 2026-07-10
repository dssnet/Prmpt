/**
 * Right-click menu for editable text fields (inputs / textareas anywhere in
 * the app — Home forms, settings, panel fields, overlays). Same in-webview
 * `FloatingMenu` as the terminal menu; the actions close over the field that
 * was right-clicked, so they keep working even though clicking a menu item
 * moves focus off the field.
 */
import { ClipboardPaste, Copy, Scissors, TextSelect } from "lucide-vue-next";

import { openFloatingMenu } from "./floatingMenu";
import {
  copyFromInput,
  cutFromInput,
  inputHasSelection,
  pasteIntoInput,
  selectAllInInput,
  type EditableInput,
} from "../lib/editable";

export function openInputContextMenu(e: MouseEvent, el: EditableInput): void {
  const hasSel = inputHasSelection(el);
  const writable = !el.readOnly && !el.disabled;
  openFloatingMenu(e.clientX, e.clientY, [
    {
      text: "Cut",
      icon: Scissors,
      disabled: !hasSel || !writable,
      action: () => void cutFromInput(el),
    },
    {
      text: "Copy",
      icon: Copy,
      disabled: !hasSel,
      action: () => void copyFromInput(el),
    },
    {
      text: "Paste",
      icon: ClipboardPaste,
      disabled: !writable,
      action: () => void pasteIntoInput(el),
    },
    null,
    {
      text: "Select All",
      icon: TextSelect,
      disabled: !el.value,
      action: () => selectAllInInput(el),
    },
  ]);
}
