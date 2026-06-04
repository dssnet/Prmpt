/**
 * Local file-browser visibility + layout. Unlike the SFTP panel (which
 * auto-opens for SSH tabs), the local browser is opt-in: hidden by default,
 * shown only when the user toggles it (Cmd/Ctrl+B). The last-used choice
 * becomes the default for newly focused terminal tabs (persisted).
 *
 * Mirrors `state/sftp.ts` so the right-side panel and the workspace-pane docks
 * share one per-tab visibility model keyed by tab id.
 */
import { ref } from "vue";

const SHOWN_KEY = "prmpt.localPanelShown";

// Global default applied to any terminal tab the user hasn't explicitly
// toggled. Defaults to hidden (the panel is opt-in).
const defaultShown = ref(localStorage.getItem(SHOWN_KEY) === "1");
// Per-tab overrides (tab ids are ephemeral, so this isn't persisted).
const overrides = ref<Record<number, boolean>>({});

export function isLocalVisible(tabId: number): boolean {
  return overrides.value[tabId] ?? defaultShown.value;
}

export function toggleLocalBrowser(tabId: number): void {
  const next = !isLocalVisible(tabId);
  overrides.value = { ...overrides.value, [tabId]: next };
  defaultShown.value = next;
  localStorage.setItem(SHOWN_KEY, next ? "1" : "0");
}

/** Drop a closed tab's override so the map doesn't grow unbounded. */
export function forgetLocalPanel(tabId: number): void {
  if (tabId in overrides.value) {
    const next = { ...overrides.value };
    delete next[tabId];
    overrides.value = next;
  }
}

// Note: docked local browsers share the SFTP dock-height ratio (see
// `state/sftp.ts` `sftpDockRatio`) so resizing any dock resizes them all.
