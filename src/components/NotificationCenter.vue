<script setup lang="ts">
/**
 * Tab-bar notification center: a bell button with an unread badge that
 * drops down the session's notification history (terminal bells / OSC
 * notifications, file-transfer completions — everything routed through
 * `state/notifications.ts::notify()`). Clicking an entry jumps to its tab.
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Bell, Trash2 } from "lucide-vue-next";

import {
  clearNotifications,
  markAllNotificationsRead,
  notificationLog,
  unreadCount,
  type NotificationEntry,
} from "../state/notifications";
import { owningTabId, setActive } from "../state/tabs";

const open = ref(false);
const triggerEl = ref<HTMLButtonElement | null>(null);
const panelEl = ref<HTMLDivElement | null>(null);

function toggle(e: MouseEvent): void {
  e.stopPropagation();
  open.value = !open.value;
}

// Opening acknowledges everything: the badge counts missed events, and
// the panel is the act of looking at them.
watch(open, (o) => {
  if (o) markAllNotificationsRead();
});

// Swing the bell when a new unread notification lands. The tick re-keys the
// icon wrapper so a notification arriving mid-swing restarts the animation.
// No ring while the panel is open — the list updating is feedback enough.
const ringTick = ref(0);
watch(unreadCount, (n, old) => {
  if (n > old && !open.value) ringTick.value++;
});

function jumpTo(n: NotificationEntry): void {
  const top = owningTabId(n.tabId);
  if (top != null) setActive(top);
  open.value = false;
}

// Relative timestamps re-render off a 30s ticker while the panel is open
// (Date.now() in a template isn't reactive on its own).
const nowTick = ref(Date.now());
let tickTimer: number | undefined;
watch(open, (o) => {
  window.clearInterval(tickTimer);
  if (o) {
    nowTick.value = Date.now();
    tickTimer = window.setInterval(() => {
      nowTick.value = Date.now();
    }, 30_000);
  }
});

function timeAgo(at: number): string {
  const s = Math.floor((nowTick.value - at) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(at).toLocaleDateString();
}

function onDocMouseDown(e: MouseEvent): void {
  if (!open.value) return;
  const target = e.target as Node | null;
  if (!target) return;
  if (panelEl.value?.contains(target)) return;
  if (triggerEl.value?.contains(target)) return;
  open.value = false;
}
function onKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape" && open.value) open.value = false;
}

onMounted(() => {
  document.addEventListener("mousedown", onDocMouseDown);
  document.addEventListener("keydown", onKeyDown);
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocMouseDown);
  document.removeEventListener("keydown", onKeyDown);
  window.clearInterval(tickTimer);
});
</script>

<template>
  <div class="relative flex-none">
    <button
      ref="triggerEl"
      type="button"
      title="Notifications"
      class="relative flex items-center justify-center w-6 h-6 rounded-full cursor-pointer transition-colors duration-100"
      :class="
        open
          ? 'bg-surface-3 text-fg'
          : 'bg-surface-1 text-fg-subtle hover:bg-surface-2 hover:text-fg-muted'
      "
      @click="toggle"
    >
      <span
        :key="ringTick"
        class="inline-flex"
        :class="{ 'bell-ring': ringTick > 0 }"
      >
        <Bell :size="13" />
      </span>
      <span
        v-if="unreadCount > 0"
        class="absolute -top-1 -right-1 min-w-3.5 h-3.5 px-0.5 inline-flex items-center justify-center rounded-full bg-accent text-[9px] font-medium leading-none text-bg tabular-nums"
      >
        {{ unreadCount > 9 ? "9+" : unreadCount }}
      </span>
    </button>
    <Transition name="overflow-panel">
      <div
        v-if="open"
        ref="panelEl"
        class="notif-panel absolute right-0 top-full mt-1 w-72 z-50 rounded-lg bg-surface-1 ring-1 ring-border-strong shadow-[0_8px_24px_rgba(0,0,0,0.35)] text-xs"
      >
        <div
          class="flex items-center justify-between px-2.5 py-1.5 border-b border-border"
        >
          <span class="font-medium text-fg">Notifications</span>
          <button
            v-if="notificationLog.length > 0"
            type="button"
            title="Clear all"
            class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg cursor-pointer"
            @click="clearNotifications"
          >
            <Trash2 :size="11" />
            Clear
          </button>
        </div>
        <div
          v-if="notificationLog.length === 0"
          class="px-2.5 py-4 text-center text-fg-subtle"
        >
          No notifications yet
        </div>
        <div v-else class="max-h-80 overflow-y-auto p-1">
          <button
            v-for="n in notificationLog"
            :key="n.id"
            type="button"
            class="w-full flex flex-col gap-0.5 px-2 py-1.5 rounded-md text-left cursor-pointer hover:bg-surface-2"
            @click="jumpTo(n)"
          >
            <span class="flex items-center gap-1.5 min-w-0 w-full">
              <span
                class="notif-host flex-none"
                :class="{ 'notif-host-error': n.kind === 'error' }"
                :title="n.host"
              >
                {{ n.host }}
              </span>
              <span
                class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-medium"
                :class="n.kind === 'error' ? 'text-danger' : 'text-fg'"
              >
                {{ n.title }}
              </span>
              <span class="flex-none text-fg-subtle">{{ timeAgo(n.at) }}</span>
            </span>
            <span
              class="block w-full overflow-hidden text-ellipsis whitespace-nowrap text-fg-subtle"
              :title="n.detail"
            >
              {{ n.detail }}
            </span>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.notif-panel {
  transform-origin: top right;
}
/* Same origin pill as the toast's .toast-host — keep the two in sync. */
.notif-host {
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 7px;
  font-size: 10px;
  border-radius: 9999px;
  color: var(--accent, #89b4fa);
  background: color-mix(in srgb, var(--accent, #89b4fa) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent, #89b4fa) 35%, transparent);
}
.notif-host-error {
  color: var(--danger, #f38ba8);
  background: color-mix(in srgb, var(--danger, #f38ba8) 14%, transparent);
  border-color: color-mix(in srgb, var(--danger, #f38ba8) 35%, transparent);
}
.overflow-panel-enter-active {
  transition:
    transform 200ms cubic-bezier(0.34, 1.5, 0.6, 1),
    opacity 160ms ease-out;
}
.overflow-panel-leave-active {
  transition:
    transform 120ms ease-in,
    opacity 100ms ease-in;
}
.overflow-panel-enter-from,
.overflow-panel-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(-6px);
}
</style>
