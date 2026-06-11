/**
 * Centralized notification dispatch. Every "something finished while you
 * weren't looking" event — a terminal bell / OSC notification (Claude Code
 * finishing a task), a file transfer completing — goes through `notify()`,
 * which fans out to the three signals:
 *
 *  - **chime** (Web Audio): on every event, gated on the Settings →
 *    Notifications sound toggle;
 *  - **toast** (bottom-right): only when the user is away — window
 *    unfocused or the originating tab not active — and gated on the toast
 *    toggle inside `showToast` itself;
 *  - **tab-bar bell badge** on the owning top-level tab: only when away,
 *    cleared when the tab is next visited.
 *
 * Every event also lands in `notificationLog`, the history behind the
 * tab-bar's notification-center bell (`NotificationCenter.vue`).
 */
import { computed, ref, watch } from "vue";

import { playChime } from "../audio/chime";
import { owningTabId, useTabs } from "./tabs";
import { showToast } from "./toasts";
import { notificationSounds } from "./uiPrefs";

const { tabs: allTabs, active: activeTab } = useTabs();

export interface AppNotification {
  /** Originating tab — a workspace pane id is fine, the owning top-level
   *  tab is resolved internally. */
  tabId: number;
  /** Origin badge for the toast: SSH host label or "Local". */
  host: string;
  title: string;
  detail: string;
  kind?: "info" | "error";
}

/** True when the user can't be watching `tabId` right now: the window is
 *  unfocused, the owning tab isn't the active one, or the tab is gone.
 *  Column/panel visibility is deliberately NOT the criterion (persisted
 *  layouts can show a connection's column on a different tab). */
export function isAway(tabId: number): boolean {
  const owner = owningTabId(tabId);
  return !document.hasFocus() || owner == null || owner !== activeTab.value?.id;
}

export function notify(n: AppNotification): void {
  if (notificationSounds.value) void playChime();
  const away = isAway(n.tabId);
  // Everything goes in the history; entries the user plausibly saw happen
  // (active tab, focused window) arrive pre-read so the bell badge only
  // counts genuinely missed events.
  notificationLog.value = [
    {
      id: nextNotificationId++,
      tabId: n.tabId,
      host: n.host,
      title: n.title,
      detail: n.detail,
      kind: n.kind ?? "info",
      at: Date.now(),
      read: !away,
    },
    ...notificationLog.value,
  ].slice(0, MAX_LOG);
  if (!away) return;
  showToast({ host: n.host, title: n.title, detail: n.detail, kind: n.kind });
  ringBell(n.tabId);
}

// ---- notification center (history) ------------------------------------------

export interface NotificationEntry {
  id: number;
  tabId: number;
  host: string;
  title: string;
  detail: string;
  kind: "info" | "error";
  /** Epoch ms at fire time. */
  at: number;
  read: boolean;
}

const MAX_LOG = 100;
let nextNotificationId = 1;

/** Newest first, capped at MAX_LOG. Session-only by design — notification
 *  history isn't worth persisting across restarts. */
export const notificationLog = ref<NotificationEntry[]>([]);

export const unreadCount = computed(
  () => notificationLog.value.filter((n) => !n.read).length,
);

export function markAllNotificationsRead(): void {
  if (notificationLog.value.every((n) => n.read)) return;
  notificationLog.value = notificationLog.value.map((n) =>
    n.read ? n : { ...n, read: true },
  );
}

export function clearNotifications(): void {
  notificationLog.value = [];
}

// ---- tab-bar bells ----------------------------------------------------------
// Top-level tabs with a notification that fired while the tab wasn't active;
// TabBar shows a bell on them until they're visited.
export const bellTabs = ref<Set<number>>(new Set());

function ringBell(tabId: number): void {
  const top = owningTabId(tabId);
  // No badge for the active tab (the toast/chime already covered it — and
  // the visit-watch below would clear it immediately) or for a tab that's
  // gone (the toast is then the only signal left).
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
