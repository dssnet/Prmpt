/**
 * Shared file-browser preferences. A single option set is shared by both the
 * local file browser and the SFTP browser (toggling in one updates the other),
 * persisted across restarts. Mirrors the localStorage-backed shared-state
 * pattern used for `dockRatio` in `state/sftp.ts`.
 */
import { ref } from "vue";

const HIDDEN_KEY = "prmpt.showHiddenFiles";

// Whether dot-prefixed (hidden) entries are shown. Defaults to hidden when the
// user has never chosen, matching most GUI file browsers.
export const showHiddenFiles = ref(localStorage.getItem(HIDDEN_KEY) === "1");

export function toggleHiddenFiles(): void {
  const next = !showHiddenFiles.value;
  showHiddenFiles.value = next;
  localStorage.setItem(HIDDEN_KEY, next ? "1" : "0");
}
