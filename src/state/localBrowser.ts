/**
 * Local file-browser visibility + layout. Unlike the SFTP panel (which
 * auto-opens for SSH tabs), the local browser is opt-in: every terminal tab
 * starts hidden and toggling (Cmd/Ctrl+B) affects only that tab — there is
 * deliberately no shared default that would make one tab's toggle leak into
 * the others.
 *
 * Mirrors `state/sftp.ts` so the right-side panel and the workspace-pane docks
 * share one per-tab visibility model keyed by tab id.
 */
import { ref } from "vue";

// Per-tab visibility (tab ids are ephemeral, so this isn't persisted).
const overrides = ref<Record<number, boolean>>({});

export function isLocalVisible(tabId: number): boolean {
  return overrides.value[tabId] ?? false;
}

export function toggleLocalBrowser(tabId: number): void {
  overrides.value = { ...overrides.value, [tabId]: !isLocalVisible(tabId) };
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
