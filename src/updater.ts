import { type } from "@tauri-apps/plugin-os";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

// How often the app re-checks GitHub for a newer release while running,
// in addition to the once-on-launch check. Six hours keeps a long-lived
// terminal session from going stale without hammering the releases CDN.
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Ask the configured updater endpoint whether a newer signed release
 * exists. Returns the `Update` handle if one is available, or `null` if
 * we're already current. Network failure / no release / unsupported
 * target are all non-fatal — they log and resolve `null` so a missing
 * internet connection never blocks or crashes the app.
 */
export async function checkForUpdate(): Promise<Update | null> {
  try {
    return await check();
  } catch (err) {
    console.error("[updater] check failed:", err);
    return null;
  }
}

/**
 * Download the update bytes to a temp location without installing,
 * reporting progress as a 0..1 fraction (or `null` while the total size
 * is unknown). Throws on failure. Kept separate from `installAndExit`
 * so the caller can close all other OS windows in between — that gives
 * the user a clean "Installing…" state and, on Windows, ensures no
 * other window is racing the NSIS installer when it fires.
 */
export async function downloadUpdate(
  update: Update,
  onProgress?: (fraction: number | null) => void,
): Promise<void> {
  let total = 0;
  let received = 0;
  await update.download((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? 0;
        onProgress?.(total > 0 ? 0 : null);
        break;
      case "Progress":
        received += event.data.chunkLength;
        onProgress?.(total > 0 ? Math.min(received / total, 1) : null);
        break;
      case "Finished":
        onProgress?.(1);
        break;
    }
  });
}

/**
 * Run the platform installer for an already-downloaded update, then
 * leave the current process so the new version can take over.
 *
 * On Windows the NSIS installer relaunches the app itself; calling
 * `relaunch()` here races the installer (re-spawning the old .exe right
 * as the installer wants to overwrite it, which surfaces as the
 * "prmpt.exe is still running" install error). On macOS/Linux nothing
 * else restarts us, so we have to call `relaunch()` ourselves.
 *
 * Either branch terminates the process; the return type is `never` to
 * make that explicit at call sites.
 */
export async function installAndExit(update: Update): Promise<never> {
  await update.install();
  if (type() === "windows") {
    await exit(0);
  } else {
    await relaunch();
  }
  throw new Error("unreachable: process did not exit after install");
}
