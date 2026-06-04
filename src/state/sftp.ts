/**
 * SFTP panel visibility. The panel auto-opens for SSH tabs; a per-tab toggle
 * can hide it to reclaim full terminal width. The last-used choice is the
 * default for newly opened SSH tabs (persisted across restarts).
 */
import { ref } from "vue";

const SHOWN_KEY = "prmpt.sftpPanelShown";

// Global default applied to any tab the user hasn't explicitly toggled.
const defaultShown = ref(localStorage.getItem(SHOWN_KEY) !== "0");
// Per-tab overrides (tab ids are ephemeral, so this isn't persisted).
const overrides = ref<Record<number, boolean>>({});

export function isSftpVisible(tabId: number): boolean {
  return overrides.value[tabId] ?? defaultShown.value;
}

export function toggleSftpPanel(tabId: number): void {
  const next = !isSftpVisible(tabId);
  overrides.value = { ...overrides.value, [tabId]: next };
  defaultShown.value = next;
  localStorage.setItem(SHOWN_KEY, next ? "1" : "0");
}

/** Drop a closed tab's override so the map doesn't grow unbounded. */
export function forgetSftpPanel(tabId: number): void {
  if (tabId in overrides.value) {
    const next = { ...overrides.value };
    delete next[tabId];
    overrides.value = next;
  }
}
