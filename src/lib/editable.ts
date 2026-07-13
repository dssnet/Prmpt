import { readText as readClipboardText } from "@tauri-apps/plugin-clipboard-manager";

export type EditableInput = HTMLInputElement | HTMLTextAreaElement;

// Resolve an editable text field from a candidate element. Pass an event's
// `target` to test where a keystroke *originated* rather than the live
// `document.activeElement`: an input's own Enter handler may tear itself down
// (navigate / close) before the event bubbles to the window listener, leaving
// `activeElement` on <body> — so a target-blind check would wrongly forward the
// Enter to the PTY. Defaults to `activeElement` when no candidate is given.
export function focusedEditable(candidate?: EventTarget | null): EditableInput | null {
  const el = (candidate as Element | null) ?? document.activeElement;
  if (el instanceof HTMLTextAreaElement) {
    // The hidden IME-capture textarea (TerminalView) holds keyboard focus on
    // behalf of the terminal — treat it as "not editable" so keystrokes,
    // paste, and Edit-menu actions route to the PTY, not into the field.
    if (el.dataset.imeCapture != null) return null;
    return el;
  }
  if (el instanceof HTMLInputElement) {
    // Bail on inputs that don't carry editable text (checkbox/radio/buttons).
    const t = el.type;
    if (
      t === "text" ||
      t === "password" ||
      t === "search" ||
      t === "email" ||
      t === "url" ||
      t === "tel" ||
      t === "number"
    ) {
      return el;
    }
  }
  return null;
}

// type=number / type=password may not expose selectionStart usefully — a null
// range reads as "no selection" and Copy/Cut stay disabled there.
export function inputHasSelection(el: EditableInput): boolean {
  return (el.selectionEnd ?? 0) > (el.selectionStart ?? 0);
}

export async function copyFromInput(el: EditableInput): Promise<void> {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  if (end <= start) return;
  const text = el.value.substring(start, end);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error("clipboard write failed:", err);
  }
}

export async function cutFromInput(el: EditableInput): Promise<void> {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  if (end <= start) return;
  const text = el.value.substring(start, end);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error("clipboard write failed:", err);
    return; // don't destroy the selection if the copy half failed
  }
  el.value = el.value.substring(0, start) + el.value.substring(end);
  el.focus();
  try {
    el.setSelectionRange(start, start);
  } catch {
    /* type=number rejects setSelectionRange */
  }
  // Vue's v-model listens on `input`; without this dispatch the reactive
  // state would stay stale even though the DOM value updated.
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export async function pasteIntoInput(el: EditableInput): Promise<void> {
  let text: string;
  try {
    text = await readClipboardText();
  } catch (err) {
    console.error("clipboard read failed:", err);
    return;
  }
  if (!text) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.substring(0, start) + text + el.value.substring(end);
  const cursor = start + text.length;
  // Refocus: a context-menu click moved focus off the field mid-edit.
  el.focus();
  try {
    el.setSelectionRange(cursor, cursor);
  } catch {
    /* type=number rejects setSelectionRange */
  }
  // Vue's v-model listens on `input`; without this dispatch the reactive
  // state would stay stale even though the DOM value updated.
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function selectAllInInput(el: EditableInput): void {
  el.focus();
  try {
    el.select();
  } catch {
    /* some input types refuse select() */
  }
}
