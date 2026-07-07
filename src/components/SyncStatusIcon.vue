<script setup lang="ts">
/**
 * Cloud badge for the home view: one glance shows whether this install is
 * in sync with the WebDAV server. Hidden entirely while sync is disabled.
 * Clicking it runs a sync immediately.
 *
 *   syncing — pulsing cloud (accent)
 *   failed  — alert cloud (danger), tooltip carries the error
 *   stale   — upload cloud (accent): local changes pending, or the last
 *             successful sync is old enough that remote edits may be waiting
 *   synced  — check cloud (muted)
 */
import { Cloud, CloudAlert, CloudCheck, CloudUpload } from "lucide-vue-next";
import { computed, onBeforeUnmount, ref } from "vue";

import {
  lastSyncAt,
  lastSyncError,
  syncBusy,
  syncEnabled,
  syncNow,
  syncPending,
} from "../state/sync";

/** Re-evaluated clock so the age-based stale state flips without any
 *  sync-engine event happening. */
const now = ref(Date.now());
const tick = window.setInterval(() => {
  now.value = Date.now();
}, 30_000);
onBeforeUnmount(() => window.clearInterval(tick));

const STALE_AFTER_MS = 15 * 60_000;

type SyncState = "syncing" | "failed" | "stale" | "synced";

const state = computed<SyncState>(() => {
  if (syncBusy.value) return "syncing";
  if (lastSyncError.value) return "failed";
  const last = lastSyncAt.value ? new Date(lastSyncAt.value).getTime() : NaN;
  if (syncPending.value || !Number.isFinite(last) || now.value - last > STALE_AFTER_MS) {
    return "stale";
  }
  return "synced";
});

const icon = computed(() => {
  switch (state.value) {
    case "syncing":
      return Cloud;
    case "failed":
      return CloudAlert;
    case "stale":
      return CloudUpload;
    default:
      return CloudCheck;
  }
});

const colorClass = computed(() => {
  switch (state.value) {
    case "syncing":
      return "text-accent animate-pulse";
    case "failed":
      return "text-danger";
    case "stale":
      return "text-accent";
    default:
      return "text-fg-muted";
  }
});

const title = computed(() => {
  switch (state.value) {
    case "syncing":
      return "Syncing…";
    case "failed":
      return `Sync failed: ${lastSyncError.value} — click to retry`;
    case "stale":
      return syncPending.value
        ? "Local changes not synced yet — click to sync"
        : "Last sync is a while ago — click to sync";
    default: {
      const at = lastSyncAt.value ? new Date(lastSyncAt.value) : null;
      const when = at && !Number.isNaN(at.getTime()) ? ` — last sync ${at.toLocaleTimeString()}` : "";
      return `Synced${when}. Click to sync now`;
    }
  }
});
</script>

<template>
  <button
    v-if="syncEnabled"
    type="button"
    :title="title"
    aria-label="Sync status — click to sync now"
    :disabled="syncBusy"
    class="shrink-0 grid place-items-center w-7 h-7 rounded-md hover:bg-surface-2 cursor-pointer transition-colors duration-150 disabled:cursor-default"
    @click="() => void syncNow()"
  >
    <component :is="icon" :size="16" class="shrink-0" :class="colorClass" />
  </button>
</template>
