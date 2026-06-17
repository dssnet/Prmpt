import { ref, shallowRef } from "vue";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type Update } from "@tauri-apps/plugin-updater";

import { autoOpenUpdateDialog } from "./uiPrefs";
import { checkForUpdate, downloadUpdate, installAndExit } from "../updater";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "uptodate"
  | "error";

const status = ref<UpdateStatus>("idle");
// `Update` is an external class with a private field; a deep `ref` would
// unwrap it and strip the nominal brand. It's an opaque handle anyway —
// keep it shallow.
const available = shallowRef<Update | null>(null);
// 0..1 download fraction, or null when the total size is unknown
// (indeterminate progress bar).
const progress = ref<number | null>(null);
const errorMessage = ref<string>("");
// Whether the update dialog is actually on screen. Decoupled from
// `status === "available"`: a background check always surfaces the
// tab-bar download icon (status "available"), but whether it also pops
// the modal depends on the "Show update dialog automatically" setting
// (see `runUpdateCheck`). The icon's click handler (`openUpdateModal`)
// opens it on demand.
const modalOpen = ref(false);

export function useUpdate() {
  return { status, available, progress, errorMessage, modalOpen };
}

/** Open the update dialog for an already-detected, pending update. */
export function openUpdateModal(): void {
  if (status.value === "available") modalOpen.value = true;
}

/**
 * Run an update check and drive the store/modal.
 *
 * `announce` controls the no-update case: the manual ("Check for
 * updates") path passes `true` so the user gets an explicit "you're up
 * to date" confirmation; the silent startup + interval checks leave it
 * `false` so they only ever surface the modal when an update exists.
 *
 * No-ops while an update is already being shown or installed so a
 * background interval tick can't interrupt an in-progress download.
 */
export async function runUpdateCheck(announce = false): Promise<void> {
  if (
    status.value === "available" ||
    status.value === "downloading" ||
    status.value === "installing" ||
    status.value === "checking"
  ) {
    return;
  }
  status.value = "checking";
  const update = await checkForUpdate();
  if (update) {
    available.value = update;
    status.value = "available";
    // A manual "Check for updates" (announce) always opens the dialog.
    // Silent startup/interval checks only open it when the user has left
    // "Show update dialog automatically" on; otherwise they just light up
    // the tab-bar download icon.
    modalOpen.value = announce || autoOpenUpdateDialog.value;
  } else if (announce) {
    status.value = "uptodate";
  } else {
    status.value = "idle";
  }
}

/**
 * Download the pending update, then close every other OS window via the
 * `prepare_for_update` backend command, then run the platform installer
 * and exit. The other-windows close happens *after* a successful
 * download so a network failure doesn't tear down the user's session
 * for nothing; it happens *before* `installAndExit` so the NSIS
 * installer on Windows isn't fighting other live webviews.
 */
export async function installUpdate(): Promise<void> {
  const update = available.value;
  if (!update) return;
  status.value = "downloading";
  progress.value = null;
  try {
    await downloadUpdate(update, (f) => {
      progress.value = f;
    });
    status.value = "installing";
    await invoke("prepare_for_update", {
      currentLabel: getCurrentWebviewWindow().label,
    });
    await installAndExit(update);
    // unreachable — installAndExit terminates the process.
  } catch (err) {
    console.error("[updater] install failed:", err);
    errorMessage.value = String(err);
    status.value = "error";
  }
}

/**
 * Dismiss the modal ("Later" / close after up-to-date / error).
 *
 * "Later" on an available update only closes the dialog — `status`
 * stays "available" so the tab-bar download icon persists and the user
 * can reopen it. The terminal info states (uptodate / error) reset back
 * to idle since there's nothing left to act on.
 */
export function dismissUpdate(): void {
  modalOpen.value = false;
  if (status.value !== "available") {
    status.value = "idle";
    available.value = null;
    progress.value = null;
    errorMessage.value = "";
  }
}
