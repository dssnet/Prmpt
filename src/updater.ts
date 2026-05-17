import { relaunch } from "@tauri-apps/plugin-process";
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
 * Download + install the given update, reporting download progress as a
 * 0..1 fraction (or `null` while the total size is unknown), then
 * relaunch into the new version. Throws on failure so the caller can
 * surface it; the app stays on the old version until the relaunch.
 */
export async function downloadAndInstall(
  update: Update,
  onProgress?: (fraction: number | null) => void,
): Promise<void> {
  let total = 0;
  let received = 0;
  await update.downloadAndInstall((event) => {
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
  await relaunch();
}
