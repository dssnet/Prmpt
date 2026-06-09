/**
 * Global SFTP transfer tracking. Rows live here (not in the browser
 * components) so an in-flight upload/download/relay/delete stays visible
 * across tab switches — the panel unmounts but the backend task keeps
 * running, and the rows are re-rendered when the column comes back.
 *
 * Each row carries a destination `key` ("sftp:<tabId>" or "local") that the
 * browser columns filter on, so any column currently showing that
 * connection (or the local filesystem) displays the transfer.
 */
import { ref, watch } from "vue";

import { onSftpTransferProgress } from "../ipc";
import { listSshConnections, owningTabId, useTabs } from "./tabs";
import { showToast } from "./toasts";

export interface Transfer {
  id: number;
  /** Which columns show this row: `sftp:<tabId>` or `local`. */
  key: string;
  /** Host label of the destination, resolved when the transfer starts (the
   *  connection may be gone by the time a toast needs it). */
  host: string;
  /** Tab the operation belongs to (connection tab for `sftp:` keys, the
   *  hosting tab for local columns) — rings that tab's bell when it finishes
   *  in the background. */
  tabId: number;
  name: string;
  dir: "up" | "down" | "del";
  /** Bytes for up/down; removed-entry count for del. */
  transferred: number;
  total: number | null;
  done: boolean;
  error: string | null;
}

/** Transfer ids must be unique across all browser columns: progress events
 *  are matched back by id alone. */
let nextTransferId = 1;
export function allocTransferId(): number {
  return nextTransferId++;
}

export const transfers = ref<Transfer[]>([]);

/** Strip the internal `sftp:` prefix and collapse a `"X: X"` duplicate
 *  (russh-sftp renders `{status_code}: {error_message}`, and servers often
 *  echo the same words, e.g. `Permission denied: Permission denied`). */
export function tidySftpError(message: string): string {
  let m = message.replace(/^sftp:\s*/i, "").trim();
  const dup = m.match(/^(.+?):\s*\1$/);
  if (dup) m = dup[1];
  return m;
}

function hostForKey(key: string): string {
  if (key === "local") return "Local";
  const id = Number(key.slice("sftp:".length));
  return listSshConnections().find((c) => c.id === id)?.label ?? "remote host";
}

/** Add a row and return its transfer id (pass it to the backend command). */
export function trackTransfer(
  key: string,
  tabId: number,
  name: string,
  dir: Transfer["dir"],
  total: number | null = null,
): number {
  const id = allocTransferId();
  transfers.value = [
    ...transfers.value,
    {
      id,
      key,
      host: hostForKey(key),
      tabId,
      name,
      dir,
      transferred: 0,
      total,
      done: false,
      error: null,
    },
  ];
  return id;
}

export function markTransferError(id: number, message: string): void {
  transfers.value = transfers.value.map((t) =>
    t.id === id ? { ...t, done: true, error: message } : t,
  );
}

export function dismissTransfer(id: number): void {
  transfers.value = transfers.value.filter((t) => t.id !== id);
}

function toastTitle(dir: Transfer["dir"], failed: boolean): string {
  if (dir === "del") return failed ? "Delete failed" : "Folder deleted";
  const verb = dir === "up" ? "Upload" : "Download";
  return `${verb} ${failed ? "failed" : "finished"}`;
}

// ---- tab-bar bells ----------------------------------------------------------
// Top-level tabs with a transfer that finished while the tab wasn't active;
// TabBar shows a bell on them until they're visited.
export const bellTabs = ref<Set<number>>(new Set());

const { tabs: allTabs, active: activeTab } = useTabs();

function ringBell(tabId: number): void {
  const top = owningTabId(tabId);
  // No bell for the active tab (the panel row / toast already covers it) or
  // for a tab that's gone.
  if (top == null || activeTab.value?.id === top) return;
  bellTabs.value = new Set([...bellTabs.value, top]);
}

// Visiting a tab acknowledges its bell; closed tabs drop theirs.
watch(activeTab, (a) => {
  if (a && bellTabs.value.has(a.id)) {
    const next = new Set(bellTabs.value);
    next.delete(a.id);
    bellTabs.value = next;
  }
});
watch(allTabs, (list) => {
  if (bellTabs.value.size === 0) return;
  const open = new Set(list.map((t) => t.id));
  const next = new Set([...bellTabs.value].filter((id) => open.has(id)));
  if (next.size !== bellTabs.value.size) bellTabs.value = next;
});

// One app-wide progress listener for the store's whole lifetime (rows are
// matched by globally-unique transfer id, so no per-column filtering needed).
void onSftpTransferProgress((p) => {
  const row = transfers.value.find((t) => t.id === p.transfer_id);
  if (!row) return;
  transfers.value = transfers.value.map((t) =>
    t.id === p.transfer_id
      ? {
          ...t,
          transferred: p.transferred,
          total: p.total ?? t.total,
          done: p.done,
          error: p.error ? tidySftpError(p.error) : t.error,
        }
      : t,
  );
  if (!p.done) return;
  // "Away" = the transfer's tab isn't the active one at completion. Column
  // visibility is deliberately NOT the criterion: persisted panel layouts can
  // show a connection's column on a different tab than the one the operation
  // belongs to, which would wrongly count the completion as "seen".
  // A closed owning tab also counts as away (the toast is then the only
  // signal left; the bell just no-ops).
  const owner = owningTabId(row.tabId);
  const away = owner == null || owner !== activeTab.value?.id;
  if (p.error) {
    // Failed rows always persist until dismissed; only announce if unseen.
    if (away) {
      showToast({
        host: row.host,
        title: toastTitle(row.dir, true),
        detail: row.name,
        kind: "error",
      });
      ringBell(row.tabId);
    }
  } else if (away) {
    showToast({ host: row.host, title: toastTitle(row.dir, false), detail: row.name });
    ringBell(row.tabId);
  } else {
    const id = p.transfer_id;
    setTimeout(() => dismissTransfer(id), 2500);
  }
});
