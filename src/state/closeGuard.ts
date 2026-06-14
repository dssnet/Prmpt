/**
 * Confirm-on-close guard. Every user-initiated close (tab X / middle-click /
 * Cmd+W, workspace pane X, window close) funnels through here: when the
 * "Confirm before closing" pref is on and the close would kill a running
 * foreground program — or, for window closes, drop an open SSH connection —
 * a ConfirmDialog (hosted in App.vue) is shown instead of closing directly.
 *
 * "Running" is detected on the backend per local PTY tab by comparing the
 * PTY's foreground process group against the spawned shell's pid
 * (`tab_foreground_process`). SSH tabs are opaque byte streams, so they
 * never trigger the tab-level guard — but their mere presence guards a
 * window close.
 */
import { ref } from "vue";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { closeCurrentWindow, tabForegroundProcess } from "../ipc";
import { confirmCloseRunning } from "./uiPrefs";
import {
  closePanelLeaf,
  closeTabAndForget,
  closeWorkspacePane,
  HOME_TAB_ID,
  openSshHostIds,
  useTabs,
  type TabState,
} from "./tabs";
import {
  collectLeaves,
  findLeafByTabId,
  getWorkspace,
  workspaceOfLeaf,
} from "./workspace";

export interface PendingClose {
  kind: "tab" | "pane" | "window";
  /** The tab/pane to close on confirm. Unused for window closes. */
  id?: number;
  message: string;
}

/** The confirm dialog App.vue renders; null = no dialog. */
export const pendingClose = ref<PendingClose | null>(null);

const { tabs } = useTabs();

/** Closing the last tab closes the window. A window always keeps the Home
 *  launcher tab, so "no tabs left" means no non-home tab remains. Called after
 *  a user-initiated close has removed its tab synchronously (whole tab, or the
 *  last pane of a panel-only workspace). This mirrors the natural-shell-exit
 *  path in App.vue's onExit handler so every way of closing the last tab —
 *  PTY exit, terminal tab, or panel-only tab — converges on the same result.
 *  Harmless if onExit also fires later: the webview is already gone. */
function closeWindowIfNoTabs(): void {
  if (!tabs.value.some((t) => t.kind !== "home")) {
    void closeCurrentWindow().catch((e) =>
      console.error("close window failed:", e),
    );
  }
}

/** Local-PTY leaf tab ids under a top-level tab (itself, or its workspace
 *  panes). SSH leaves are excluded — the tab-level guard can't see into
 *  them, per the window-only SSH rule. */
function localLeafIds(t: TabState): number[] {
  if (t.kind !== "workspace") return [];
  const ws = getWorkspace(t.id);
  if (!ws) return [];
  return collectLeaves(ws.root)
    .filter((l) => l.origin.kind === "terminal")
    .map((l) => l.tabId);
}

/** Names of foreground programs running in the given local tabs (deduped;
 *  unnameable processes report as "a program"). Query failures count as
 *  not-running so a wedged tab can never block its own close. */
async function runningNames(ids: number[]): Promise<string[]> {
  const procs = await Promise.all(
    ids.map((id) => tabForegroundProcess(id).catch(() => null)),
  );
  const names = new Set<string>();
  for (const p of procs) {
    if (p) names.add(p.name ? `"${p.name}"` : "a program");
  }
  return [...names];
}

function describeRunning(names: string[]): string {
  if (names.length === 1) return `${names[0]} is still running`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are still running`;
  return `${names.length} programs are still running`;
}

/** Tab X / middle-click / Cmd+W. */
export async function requestCloseTab(t: TabState): Promise<void> {
  if (t.id === HOME_TAB_ID) return;
  if (confirmCloseRunning.value) {
    const names = await runningNames(localLeafIds(t));
    if (names.length > 0) {
      pendingClose.value = {
        kind: "tab",
        id: t.id,
        message: `${describeRunning(names)} in this tab. Close it anyway?`,
      };
      return;
    }
  }
  void closeTabAndForget(t.id);
  closeWindowIfNoTabs();
}

/** Workspace pane X. Looks up the pane's origin itself; SSH panes close
 *  without confirmation, same as SSH tabs. Panel panes (file browser, git, …)
 *  are frontend-only views — close immediately, nothing can be "running". */
export async function requestClosePane(tabId: number): Promise<void> {
  const wsId = workspaceOfLeaf(tabId);
  const ws = wsId !== undefined ? getWorkspace(wsId) : undefined;
  const leaf = ws ? findLeafByTabId(ws.root, tabId) : null;
  if (leaf?.origin.kind === "panel") {
    if (wsId !== undefined) closePanelLeaf(wsId, tabId);
    // Closing the last pane of a panel-only workspace removes the tab outright.
    closeWindowIfNoTabs();
    return;
  }
  if (confirmCloseRunning.value) {
    if (leaf?.origin.kind === "terminal") {
      const names = await runningNames([tabId]);
      if (names.length > 0) {
        pendingClose.value = {
          kind: "pane",
          id: tabId,
          message: `${describeRunning(names)} in this pane. Close it anyway?`,
        };
        return;
      }
    }
  }
  void closeWorkspacePane(tabId);
}

/** Reason this window shouldn't close silently (running programs in local
 *  tabs/panes, open SSH connections), or null when it's fine to close.
 *  Used by App.vue's onCloseRequested handler. */
export async function windowCloseMessage(): Promise<string | null> {
  if (!confirmCloseRunning.value) return null;
  const localIds: number[] = [];
  for (const t of tabs.value) {
    if (t.kind !== "workspace") continue;
    const ws = getWorkspace(t.id);
    if (!ws) continue;
    for (const leaf of collectLeaves(ws.root)) {
      if (leaf.origin.kind === "terminal") localIds.push(leaf.tabId);
    }
  }
  // Distinct pooled SSH connections (shells + file browsers, deduped by host).
  const sshCount = openSshHostIds().size;
  const parts: string[] = [];
  const names = await runningNames(localIds);
  if (names.length > 0) parts.push(describeRunning(names));
  if (sshCount > 0) {
    parts.push(
      sshCount === 1
        ? "an SSH connection is open"
        : `${sshCount} SSH connections are open`,
    );
  }
  if (parts.length === 0) return null;
  const reason = parts.join(", and ");
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)} in this window. Close it anyway?`;
}

export function confirmPendingClose(): void {
  const p = pendingClose.value;
  pendingClose.value = null;
  if (!p) return;
  if (p.kind === "tab" && p.id !== undefined) {
    void closeTabAndForget(p.id);
    closeWindowIfNoTabs();
  } else if (p.kind === "pane" && p.id !== undefined) {
    void closeWorkspacePane(p.id);
  } else if (p.kind === "window") {
    // destroy(), not close(): close() would re-fire onCloseRequested and
    // re-run this guard. The Destroyed handler on the backend still reaps
    // the window's tabs.
    void getCurrentWebviewWindow().destroy();
  }
}

export function cancelPendingClose(): void {
  pendingClose.value = null;
}

export function pendingCloseTitle(kind: PendingClose["kind"]): string {
  if (kind === "window") return "Close window?";
  if (kind === "pane") return "Close pane?";
  return "Close tab?";
}
