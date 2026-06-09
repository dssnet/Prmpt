/**
 * UI behavior preferences, persisted in config.toml's `[ui]` section (loaded
 * with the rest of the config at startup, written back via `set_ui_prefs`).
 * Window-layout state (panel visibility, widths, ratios) deliberately stays
 * in localStorage — per-machine ephemera, not configuration.
 */
import { ref } from "vue";

import { setUiPrefs, type UiPrefs } from "../ipc";

/** Toast popups when a file operation finishes on a background tab. */
export const toastsEnabled = ref(true);

/** Show dot-prefixed (hidden) entries in the file browsers — shared by the
 *  local and SFTP browsers (toggling in one updates the other). */
export const showHiddenFiles = ref(false);

/** Seed from the loaded config (called once at startup, before mount). Values
 *  left over in localStorage from when these prefs lived there are adopted
 *  into the config once, then removed. */
export function initUiPrefs(ui: UiPrefs): void {
  const lsToasts = localStorage.getItem("prmpt.toastsEnabled");
  const lsHidden = localStorage.getItem("prmpt.showHiddenFiles");
  toastsEnabled.value = lsToasts !== null ? lsToasts !== "0" : ui.toast_notifications;
  showHiddenFiles.value = lsHidden !== null ? lsHidden === "1" : ui.show_hidden_files;
  if (lsToasts !== null || lsHidden !== null) {
    localStorage.removeItem("prmpt.toastsEnabled");
    localStorage.removeItem("prmpt.showHiddenFiles");
    void persist();
  }
}

function persist(): Promise<void> {
  return setUiPrefs({
    toast_notifications: toastsEnabled.value,
    show_hidden_files: showHiddenFiles.value,
  });
}

export function setToastsEnabled(v: boolean): void {
  toastsEnabled.value = v;
  void persist();
}

export function toggleHiddenFiles(): void {
  showHiddenFiles.value = !showHiddenFiles.value;
  void persist();
}
