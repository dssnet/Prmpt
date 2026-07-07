<script setup lang="ts">
import { AlertTriangle, Check, Copy, Plus, Trash2 } from "lucide-vue-next";
import { onMounted, ref, watch } from "vue";

import { useDomScroll } from "../composables/useDomScroll";
import { deleteKey, listKeys, type SshKeyRow } from "../db";
import { deleteSecret, keyPassphraseKey, keyPrivateKey } from "../secrets";
import { syncDataVersion } from "../state/sync";
import { Button, ConfirmDialog, EmptyState, PageHeader, Scrollbar } from "./ui";

const emit = defineEmits<{ back: []; addKey: []; editKey: [k: SshKeyRow] }>();

const keys = ref<SshKeyRow[]>([]);
const errorText = ref<string | null>(null);

const scrollRoot = ref<HTMLElement | null>(null);
const { position, range, viewportSize, onScrollTo, onPageBy } =
  useDomScroll(scrollRoot);

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
// WebDAV sync applied remote changes — reload from the DB.
watch(syncDataVersion, () => void refresh());
defineExpose({ refresh });

const deleteTarget = ref<SshKeyRow | null>(null);

function requestDelete(k: SshKeyRow) {
  deleteTarget.value = k;
}

async function confirmDelete() {
  const k = deleteTarget.value;
  if (!k) return;
  try {
    await deleteKey(k.id);
    await deleteSecret(keyPrivateKey(k.id)).catch(() => undefined);
    await deleteSecret(keyPassphraseKey(k.id)).catch(() => undefined);
    deleteTarget.value = null;
    await refresh();
  } catch (err) {
    console.error("deleteKey failed:", err);
    errorText.value = `Delete failed: ${err}`;
    deleteTarget.value = null;
  }
}

function publicSnippet(pub: string): string {
  return pub.length > 80 ? pub.slice(0, 80) + "…" : pub;
}

const copiedId = ref<number | null>(null);
let copiedTimer: number | undefined;

async function copyPublic(k: SshKeyRow) {
  if (!k.public_key) return;
  try {
    await navigator.clipboard.writeText(k.public_key);
    copiedId.value = k.id;
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => {
      copiedId.value = null;
    }, 1500);
  } catch (err) {
    console.error("copy public key failed:", err);
  }
}
</script>

<template>
  <div class="absolute inset-0 text-fg">
    <div ref="scrollRoot" class="absolute inset-0 flex flex-col gap-3.5 px-9 pt-2 pb-6 overflow-y-auto scrollbar-none">
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
          <div class="font-medium text-fg flex items-center gap-1.5">
            <span>{{ k.label }}</span>
            <AlertTriangle
              v-if="k.broken"
              :size="14"
              class="text-danger shrink-0 cursor-help"
              title="Stored passphrase / private key could not be unlocked. Edit this key to re-enter it."
            />
          </div>
          <div class="text-xs text-fg-muted font-mono">{{ k.has_passphrase ? "passphrase saved" : "no passphrase" }}</div>
          <div v-if="k.public_key" class="text-[11px] text-fg-subtle font-mono mt-1 break-all">
            {{ publicSnippet(k.public_key) }}
          </div>
        </div>
        <div class="flex gap-1.5">
          <Button
            v-if="k.public_key"
            size="sm"
            variant="secondary"
            :title="copiedId === k.id ? 'Copied!' : 'Copy public key'"
            @click="copyPublic(k)"
          >
            <Check v-if="copiedId === k.id" :size="14" />
            <Copy v-else :size="14" />
          </Button>
          <Button size="sm" variant="secondary" @click="emit('editKey', k)">Edit</Button>
          <Button size="sm" variant="danger" title="Delete key" @click="requestDelete(k)">
            <Trash2 :size="14" />
          </Button>
        </div>
      </div>
    </div>
    <EmptyState v-if="keys.length === 0 || errorText">
      {{ errorText ?? "No keys saved yet." }}
    </EmptyState>
    </div>
    <Scrollbar
      :position="position"
      :range="range"
      :viewport-size="viewportSize"
      @scroll-to="onScrollTo"
      @page-by="onPageBy"
    />

    <ConfirmDialog
      :open="deleteTarget != null"
      title="Delete key?"
      :message="deleteTarget ? `Delete “${deleteTarget.label}”? Hosts referencing it will lose the link.` : ''"
      confirm-label="Delete key"
      cancel-label="Cancel"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
  </div>
</template>
