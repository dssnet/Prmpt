<script setup lang="ts">
import { computed, ref } from "vue";
import { Columns2, X } from "lucide-vue-next";

import { listSshConnections } from "../state/tabs";
import { workspaceTick } from "../state/workspace";
import LocalBrowser from "./LocalBrowser.vue";
import SftpBrowser from "./SftpBrowser.vue";

// The left column is always the local file browser. The right column is opt-in
// (an SSH connection the user picks) and enables dragging local files onto a
// remote folder to upload them.
defineProps<{ targetTabId: number }>();
const emit = defineEmits<{ close: []; expand: [] }>();

const sftpId = ref<number | null>(null);

// SSH connections that offer SFTP, for the right column's picker.
const connections = computed(() => {
  void workspaceTick.value;
  return listSshConnections()
    .filter((c) => !c.disableSftp)
    .map((c) => ({ id: c.id, label: c.label }));
});

const canAddSftp = computed(() => sftpId.value === null && connections.value.length >= 1);

function addSftp(): void {
  const first = connections.value[0];
  if (first) {
    sftpId.value = first.id;
    emit("expand"); // ask the host to widen the panel for two columns
  }
}
</script>

<template>
  <aside class="flex flex-col min-h-0 self-stretch bg-surface-1 border-l border-border text-fg">
    <header class="flex items-center gap-1.5 px-2 h-8 border-b border-border shrink-0">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle flex-1">
        Files
      </span>
      <button
        v-if="canAddSftp"
        type="button"
        class="hdr-btn"
        title="Open an SSH connection (drag local files onto it to upload)"
        @click="addSftp"
      >
        <Columns2 :size="14" />
      </button>
      <button type="button" class="hdr-btn" title="Hide file browser" @click="emit('close')">
        <X :size="14" />
      </button>
    </header>

    <div class="flex-1 min-h-0 flex">
      <LocalBrowser class="flex-1 min-w-0" :target-tab-id="targetTabId" />
      <template v-if="sftpId !== null">
        <div class="w-px bg-border shrink-0" />
        <SftpBrowser
          class="flex-1 min-w-0"
          :tab-id="sftpId"
          :connections="connections"
          can-close
          @update:tab-id="sftpId = $event"
          @close="sftpId = null"
        />
      </template>
    </div>
  </aside>
</template>

<style scoped>
.hdr-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--fg-subtle, #9399b2);
  cursor: pointer;
  flex: none;
}
.hdr-btn:hover {
  color: var(--fg, #e6e6e6);
  background: color-mix(in srgb, var(--fg, #fff) 12%, transparent);
}
</style>
