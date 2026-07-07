/**
 * UI behavior preferences, persisted in config.toml's `[ui]` section (loaded
 * with the rest of the config at startup, written back via `set_ui_prefs`).
 * Window-layout state (panel visibility, widths, ratios) deliberately stays
 * in localStorage — per-machine ephemera, not configuration.
 */
import { ref } from "vue";

import { setUiPrefs, type StartupView, type UiPrefs } from "../ipc";

/** Toast popups when a file operation finishes on a background tab. */
export const toastsEnabled = ref(true);

/** Chime when a program rings the terminal bell or sends an OSC
 *  notification (e.g. Claude Code finishing a task). */
export const notificationSounds = ref(true);

/** When true, notification sounds only play while the app window is in the
 *  background (unfocused). Opt-in: silences the chime for a task that
 *  finished in the window you're already watching. */
export const notificationSoundsBackgroundOnly = ref(false);

/** Ask before a close would kill a running foreground program (tab or
 *  window) or drop an open SSH connection (window close only). */
export const confirmCloseRunning = ref(true);

/** Show dot-prefixed (hidden) entries in the file browsers — shared by the
 *  local and SFTP browsers (toggling in one updates the other). */
export const showHiddenFiles = ref(false);

/** Show the size column in the file browsers. */
export const showSize = ref(true);

/** Show the changed (modified) date column in the file browsers. */
export const showChangedDate = ref(false);

/** Show the created date column in the file browsers (local only — the SFTP
 *  protocol doesn't report creation time). */
export const showCreatedDate = ref(false);

/** Automatically open the update dialog when a background check finds a newer
 *  release. When false, only the tab-bar download icon appears and the dialog
 *  opens on demand. Consulted in `state/update.ts::runUpdateCheck`. */
export const autoOpenUpdateDialog = ref(true);

/** Which view a freshly-opened window with no tabs to restore lands on: a new
 *  terminal ("terminal", the historical default) or the Home tab ("home").
 *  Consulted in `App.vue::autoSpawnInitialTab`. */
export const startupView = ref<StartupView>("terminal");

/** Seed from the loaded config (called once at startup, before mount). Values
 *  left over in localStorage from when these prefs lived there are adopted
 *  into the config once, then removed. */
export function initUiPrefs(ui: UiPrefs): void {
  const lsToasts = localStorage.getItem("prmpt.toastsEnabled");
  const lsHidden = localStorage.getItem("prmpt.showHiddenFiles");
  toastsEnabled.value = lsToasts !== null ? lsToasts !== "0" : ui.toast_notifications;
  notificationSounds.value = ui.notification_sounds;
  notificationSoundsBackgroundOnly.value = ui.notification_sounds_background_only;
  confirmCloseRunning.value = ui.confirm_close_running;
  showHiddenFiles.value = lsHidden !== null ? lsHidden === "1" : ui.show_hidden_files;
  showSize.value = ui.show_size;
  showChangedDate.value = ui.show_changed_date;
  showCreatedDate.value = ui.show_created_date;
  autoOpenUpdateDialog.value = ui.auto_open_update_dialog;
  startupView.value = ui.startup_view;
  if (lsToasts !== null || lsHidden !== null) {
    localStorage.removeItem("prmpt.toastsEnabled");
    localStorage.removeItem("prmpt.showHiddenFiles");
    void persist();
  }
}

function persist(): Promise<void> {
  return setUiPrefs({
    toast_notifications: toastsEnabled.value,
    notification_sounds: notificationSounds.value,
    notification_sounds_background_only: notificationSoundsBackgroundOnly.value,
    confirm_close_running: confirmCloseRunning.value,
    show_hidden_files: showHiddenFiles.value,
    show_size: showSize.value,
    show_changed_date: showChangedDate.value,
    show_created_date: showCreatedDate.value,
    auto_open_update_dialog: autoOpenUpdateDialog.value,
    startup_view: startupView.value,
  });
}

export function setToastsEnabled(v: boolean): void {
  toastsEnabled.value = v;
  void persist();
}

export function setNotificationSounds(v: boolean): void {
  notificationSounds.value = v;
  void persist();
}

export function setNotificationSoundsBackgroundOnly(v: boolean): void {
  notificationSoundsBackgroundOnly.value = v;
  void persist();
}

export function setConfirmCloseRunning(v: boolean): void {
  confirmCloseRunning.value = v;
  void persist();
}

export function setShowHiddenFiles(v: boolean): void {
  showHiddenFiles.value = v;
  void persist();
}

export function setShowSize(v: boolean): void {
  showSize.value = v;
  void persist();
}

export function setShowChangedDate(v: boolean): void {
  showChangedDate.value = v;
  void persist();
}

export function setShowCreatedDate(v: boolean): void {
  showCreatedDate.value = v;
  void persist();
}

export function setAutoOpenUpdateDialog(v: boolean): void {
  autoOpenUpdateDialog.value = v;
  void persist();
}

export function setStartupView(v: StartupView): void {
  startupView.value = v;
  void persist();
}

export function toggleHiddenFiles(): void {
  setShowHiddenFiles(!showHiddenFiles.value);
}

export function toggleSize(): void {
  setShowSize(!showSize.value);
}

export function toggleChangedDate(): void {
  setShowChangedDate(!showChangedDate.value);
}

export function toggleCreatedDate(): void {
  setShowCreatedDate(!showCreatedDate.value);
}
