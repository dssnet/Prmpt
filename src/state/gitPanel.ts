/**
 * Git-panel UI state, hoisted out of GitPanel.vue so a tab switch (which
 * unmounts the panel pane) doesn't eat a half-written commit message or
 * collapse the log.
 *
 * Panels are self-contained now, so multiple git panels can coexist — state
 * is keyed per panel instance (by the panel pane's stable identity), like the
 * column store in `state/filesPanel.ts`. Session-only; pane ids are never
 * reused, so entries for closed panes just sit unused.
 *
 * Panel visibility itself is not tracked here: the git view is a workspace
 * panel pane (see `state/panels.ts`), opened via `openPanelPane("git", …)`.
 */
import { ref, type Ref } from "vue";

export interface GitPanelState {
  commitDraft: Ref<string>;
  logExpanded: Ref<boolean>;
}

const stateByKey = new Map<string, GitPanelState>();

export function getGitPanelState(key: string): GitPanelState {
  let s = stateByKey.get(key);
  if (!s) {
    s = { commitDraft: ref(""), logExpanded: ref(false) };
    stateByKey.set(key, s);
  }
  return s;
}
