<script setup lang="ts">
import { AlertTriangle, KeyRound, Plus, Settings, Trash2 } from "lucide-vue-next";
import { onMounted, ref } from "vue";

import { useDomScroll } from "../composables/useDomScroll";
import { deleteHost, listHosts, type SshHostRow } from "../db";
import { deleteSecret, hostPasswordKey } from "../secrets";
import { connectHost } from "../state/connect";
import { Badge, Button, EmptyState, PageHeader, Scrollbar } from "./ui";

const emit = defineEmits<{
  addHost: [];
  editHost: [host: SshHostRow];
  manageKeys: [];
  openSettings: [];
}>();

const hosts = ref<SshHostRow[]>([]);
const errorText = ref<string | null>(null);
const connecting = ref<number | null>(null);

const scrollRoot = ref<HTMLElement | null>(null);
const { position, range, viewportSize, onScrollTo, onPageBy } =
  useDomScroll(scrollRoot);

async function refresh() {
  errorText.value = null;
  try {
    hosts.value = await listHosts();
  } catch (err) {
    console.error("listHosts failed:", err);
    errorText.value = `Failed to load hosts: ${err}`;
  }
}

onMounted(refresh);
defineExpose({ refresh });

async function onConnect(h: SshHostRow) {
  connecting.value = h.id;
  try {
    await connectHost(h);
  } catch (err) {
    console.error("connect failed:", err);
    alert(`Connect failed: ${err}`);
  } finally {
    connecting.value = null;
  }
}

async function onDelete(h: SshHostRow) {
  if (!confirm(`Delete host "${h.label}"?`)) return;
  try {
    await deleteHost(h.id);
    if (h.has_password) {
      await deleteSecret(hostPasswordKey(h.id)).catch(() => undefined);
    }
    await refresh();
  } catch (err) {
    console.error("deleteHost failed:", err);
    alert(`Delete failed: ${err}`);
  }
}

function badgeText(h: SshHostRow): string {
  if (h.auth_method === "password") {
    return h.has_password ? "password" : "password (none stored)";
  }
  if (h.auth_method === "key") {
    return h.key_label ? `key: ${h.key_label}` : "key (missing)";
  }
  return "agent";
}
</script>

<template>
  <div class="absolute inset-0 text-fg">
    <div ref="scrollRoot" class="absolute inset-0 flex flex-col gap-3.5 px-9 pt-2 pb-6 overflow-y-auto scrollbar-none">
    <PageHeader title="SSH hosts">
      <template #actions>
        <Button :icon="Plus" @click="emit('addHost')">Add host</Button>
        <Button variant="secondary" :icon="KeyRound" @click="emit('manageKeys')">Manage keys</Button>
      </template>
    </PageHeader>

    <div class="flex flex-col gap-2">
      <div
        v-for="h in hosts"
        :key="h.id"
        class="flex items-center justify-between gap-3 px-3.5 py-3 border border-border rounded-lg bg-surface-1 hover:border-border-strong transition-colors duration-150"
      >
        <div class="flex flex-col gap-0.5 min-w-0 flex-1">
          <div class="font-medium text-fg flex items-center gap-1.5">
            <span>{{ h.label }}</span>
            <AlertTriangle
              v-if="h.broken"
              :size="14"
              class="text-danger shrink-0 cursor-help"
              title="Stored credentials could not be unlocked. Edit this host to re-enter the password."
            />
          </div>
          <div class="text-xs text-fg-muted font-mono">{{ h.username }}@{{ h.hostname }}:{{ h.port }}</div>
          <Badge>{{ badgeText(h) }}</Badge>
          <div v-if="h.host_fp_sha256" class="text-[11px] text-fg-subtle font-mono mt-0.5">
            fp {{ h.host_key_alg ?? "" }} {{ h.host_fp_sha256.slice(0, 24) }}…
          </div>
        </div>
        <div class="flex gap-1.5">
          <Button
            size="sm"
            :disabled="h.broken || connecting === h.id"
            @click="onConnect(h)"
          >
            Connect
          </Button>
          <Button size="sm" variant="secondary" @click="emit('editHost', h)">Edit</Button>
          <Button size="sm" variant="danger" title="Delete host" @click="onDelete(h)">
            <Trash2 :size="14" />
          </Button>
        </div>
      </div>
    </div>

    <EmptyState v-if="hosts.length === 0 || errorText">
      {{ errorText ?? "No SSH hosts yet. Click \"Add host\" to save your first connection." }}
    </EmptyState>
    </div>

    <!-- Settings button + custom scrollbar live outside the scroll container
         so they stay pinned to the visible viewport rather than scrolling
         with the list. -->
    <button
      type="button"
      title="Theme settings"
      aria-label="Open settings"
      class="absolute right-4 bottom-4 w-11 h-11 rounded-full border border-border bg-surface-1 text-fg-muted hover:bg-surface-2 hover:text-fg hover:border-border-strong text-xl flex items-center justify-center cursor-pointer transition-colors duration-150"
      @click="emit('openSettings')"
    >
      <Settings :size="20" />
    </button>
    <Scrollbar
      :position="position"
      :range="range"
      :viewport-size="viewportSize"
      @scroll-to="onScrollTo"
      @page-by="onPageBy"
    />
  </div>
</template>
