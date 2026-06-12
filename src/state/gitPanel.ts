/**
 * Git-panel visibility + hoisted UI state. Mirrors `state/localBrowser.ts`:
 * the panel is opt-in per terminal tab (Cmd/Ctrl+G), with no shared default
 * that would leak one tab's toggle into the others.
 *
 * The panel follows the local file browser's cwd (`localBrowserCwd` in
 * `state/filesPanel.ts`) to find the repo, so all tabs show the same repo —
 * only visibility is per-tab.
 */
import { ref } from "vue";

// Per-tab visibility (tab ids are ephemeral, so this isn't persisted).
const overrides = ref<Record<number, boolean>>({});

export function isGitVisible(tabId: number): boolean {
  return overrides.value[tabId] ?? false;
}

export function toggleGitPanel(tabId: number): void {
  overrides.value = { ...overrides.value, [tabId]: !isGitVisible(tabId) };
}

/** Drop a closed tab's override so the map doesn't grow unbounded. */
export function forgetGitPanel(tabId: number): void {
  if (tabId in overrides.value) {
    const next = { ...overrides.value };
    delete next[tabId];
    overrides.value = next;
  }
}

// Hoisted out of GitPanel.vue so a tab switch (which unmounts the panel)
// doesn't eat a half-written commit message or collapse the log. One slot
// each — there's one local repo context, like the "local" browser slot in
// `state/filesPanel.ts`.
export const commitDraft = ref("");
export const logExpanded = ref(false);
