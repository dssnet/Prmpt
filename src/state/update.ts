import { ref, shallowRef } from "vue";

import { type Update } from "@tauri-apps/plugin-updater";

import { checkForUpdate, downloadAndInstall } from "../updater";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
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

export function useUpdate() {
  return { status, available, progress, errorMessage };
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
    status.value === "checking"
  ) {
    return;
  }
  status.value = "checking";
  const update = await checkForUpdate();
  if (update) {
    available.value = update;
    status.value = "available";
  } else if (announce) {
    status.value = "uptodate";
  } else {
    status.value = "idle";
  }
}

/** Download + install the pending update, then relaunch. */
export async function installUpdate(): Promise<void> {
  const update = available.value;
  if (!update) return;
  status.value = "downloading";
  progress.value = null;
  try {
    await downloadAndInstall(update, (f) => {
      progress.value = f;
    });
    // relaunch() replaces the process; nothing past here runs.
  } catch (err) {
    console.error("[updater] install failed:", err);
    errorMessage.value = String(err);
    status.value = "error";
  }
}

/** Dismiss the modal ("Later" / close after up-to-date / error). */
export function dismissUpdate(): void {
  status.value = "idle";
  available.value = null;
  progress.value = null;
  errorMessage.value = "";
}
