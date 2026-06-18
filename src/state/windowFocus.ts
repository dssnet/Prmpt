/**
 * Authoritative window-focus state, sourced from the OS rather than the
 * DOM. `document.hasFocus()` reflects the *document's* focus inside the
 * webview and can lag or disagree with the real window state; Tauri's
 * `WindowEvent::Focused` (surfaced via `onFocusChanged`) is the windowing
 * system's own signal for "is this window in the foreground".
 *
 * `windowFocused` is true while the app window is the foreground window.
 * Consumers that mean "the user can't be looking at us" should read this
 * instead of `document.hasFocus()`.
 */
import { ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Optimistic default: the window is almost always focused on launch, and
// the OS event corrects it within the first tick if not.
export const windowFocused = ref(true);

export async function initWindowFocus(): Promise<void> {
  const win = getCurrentWindow();
  try {
    windowFocused.value = await win.isFocused();
  } catch (e) {
    console.error("[windowFocus] initial isFocused() failed:", e);
  }
  // onFocusChanged is the OS-backed truth from here on.
  await win.onFocusChanged(({ payload: focused }) => {
    windowFocused.value = focused;
  });
}
