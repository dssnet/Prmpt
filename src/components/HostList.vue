<script setup lang="ts">
import { KeyRound, Plus, Settings, Trash2 } from "lucide-vue-next";
import { onMounted, ref } from "vue";

import { deleteHost, listHosts, type SshHostRow } from "../db";
import { deleteSecret, hostPasswordKey } from "../secrets";
import { connectHost } from "../state/connect";
import { Badge, Button, EmptyState, PageHeader } from "./ui";

const emit = defineEmits<{
  addHost: [];
  editHost: [host: SshHostRow];
  manageKeys: [];
  openSettings: [];
}>();

const hosts = ref<SshHostRow[]>([]);
const errorText = ref<string | null>(null);
const connecting = ref<number | null>(null);

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
  <div class="absolute inset-0 flex flex-col gap-3.5 px-9 pt-8 pb-6 overflow-y-auto text-fg">
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
          <div class="font-medium text-fg">{{ h.label }}</div>
          <div class="text-xs text-fg-muted font-mono">{{ h.username }}@{{ h.hostname }}:{{ h.port }}</div>
          <Badge>{{ badgeText(h) }}</Badge>
          <Badge v-if="h.broken" tone="danger">needs re-entry</Badge>
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

    <button
      type="button"
      title="Theme settings"
      aria-label="Open settings"
      class="absolute right-4 bottom-4 w-11 h-11 rounded-full border border-border bg-surface-1 text-fg-muted hover:bg-surface-2 hover:text-fg hover:border-border-strong text-xl flex items-center justify-center cursor-pointer transition-colors duration-150"
      @click="emit('openSettings')"
    >
      <Settings :size="20" />
    </button>
  </div>
</template>
