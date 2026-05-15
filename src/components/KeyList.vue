<script setup lang="ts">
import { Plus, Trash2 } from "lucide-vue-next";
import { onMounted, ref } from "vue";

import { deleteKey, listKeys, type SshKeyRow } from "../db";
import { deleteSecret, keyPassphraseKey, keyPrivateKey } from "../secrets";
import { Badge, Button, EmptyState, PageHeader } from "./ui";

const emit = defineEmits<{ back: []; addKey: []; editKey: [k: SshKeyRow] }>();

const keys = ref<SshKeyRow[]>([]);
const errorText = ref<string | null>(null);

async function refresh() {
  errorText.value = null;
  try {
    keys.value = await listKeys();
  } catch (err) {
    console.error("listKeys failed:", err);
    errorText.value = `Failed to load keys: ${err}`;
  }
}

onMounted(refresh);
defineExpose({ refresh });

async function onDelete(k: SshKeyRow) {
  if (!confirm(`Delete key "${k.label}"? Hosts referencing it will lose the link.`)) return;
  try {
    await deleteKey(k.id);
    await deleteSecret(keyPrivateKey(k.id)).catch(() => undefined);
    await deleteSecret(keyPassphraseKey(k.id)).catch(() => undefined);
    await refresh();
  } catch (err) {
    alert(`Delete failed: ${err}`);
  }
}

function publicSnippet(pub: string): string {
  return pub.length > 80 ? pub.slice(0, 80) + "…" : pub;
}
</script>

<template>
  <div class="absolute inset-0 flex flex-col gap-3.5 px-9 pt-8 pb-6 overflow-y-auto text-fg">
    <Button variant="ghost" @click="emit('back')">← Hosts</Button>
    <PageHeader title="Saved keys">
      <template #actions>
        <Button :icon="Plus" @click="emit('addKey')">Add key</Button>
      </template>
    </PageHeader>
    <div class="flex flex-col gap-2">
      <div
        v-for="k in keys"
        :key="k.id"
        class="flex items-center justify-between gap-3 px-3.5 py-3 border border-border rounded-lg bg-surface-1 hover:border-border-strong transition-colors duration-150"
      >
        <div class="flex flex-col gap-0.5 min-w-0 flex-1">
          <div class="font-medium text-fg">{{ k.label }}</div>
          <div class="text-xs text-fg-muted font-mono">{{ k.has_passphrase ? "passphrase saved" : "no passphrase" }}</div>
          <Badge v-if="k.broken" tone="danger">needs re-entry</Badge>
          <div v-if="k.public_key" class="text-[11px] text-fg-subtle font-mono mt-1 break-all">
            {{ publicSnippet(k.public_key) }}
          </div>
        </div>
        <div class="flex gap-1.5">
          <Button size="sm" variant="secondary" @click="emit('editKey', k)">Edit</Button>
          <Button size="sm" variant="danger" title="Delete key" @click="onDelete(k)">
            <Trash2 :size="14" />
          </Button>
        </div>
      </div>
    </div>
    <EmptyState v-if="keys.length === 0 || errorText">
      {{ errorText ?? "No keys saved yet." }}
    </EmptyState>
  </div>
</template>
