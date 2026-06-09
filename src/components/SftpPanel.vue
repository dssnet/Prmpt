<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Columns2, X } from "lucide-vue-next";

import { listSshConnections } from "../state/tabs";
import { workspaceTick } from "../state/workspace";
import SftpBrowser from "./SftpBrowser.vue";

// `tabId` is the focused SSH connection; it seeds the left column and the left
// column follows focus changes. The right column is opt-in (a second
// connection the user picks) and enables drag-copy between two hosts.
const props = defineProps<{ tabId: number }>();
const emit = defineEmits<{ close: []; expand: [] }>();

const leftId = ref(props.tabId);
const rightId = ref<number | null>(null);

watch(
  () => props.tabId,
  (v) => {
    if (v === leftId.value) return;
    // Focusing the connection shown on the right (e.g. clicking its workspace
    // pane) swaps the columns instead of collapsing the dual view.
    if (v === rightId.value) {
      rightId.value = leftId.value;
      leftId.value = v;
      return;
    }
    leftId.value = v;
  },
);

// All SSH connections that offer SFTP, for the per-column pickers.
const connections = computed(() => {
  void workspaceTick.value;
  return listSshConnections()
    .filter((c) => !c.disableSftp)
    .map((c) => ({ id: c.id, label: c.label }));
});

// Collapse or repair the dual view when a shown connection goes away
// (e.g. the user closes one of the SSH tabs).
watch(connections, (list) => {
  const has = (id: number | null) => id !== null && list.some((c) => c.id === id);
  if (!has(rightId.value)) rightId.value = null;
  if (!has(leftId.value) && rightId.value !== null) {
    // Left connection died: promote the right column instead of showing a dead pane.
    leftId.value = rightId.value;
    rightId.value = null;
  }
});

const canAddSecond = computed(
  () => rightId.value === null && connections.value.length >= 2,
);

function addSecond(): void {
  const other = connections.value.find((c) => c.id !== leftId.value);
  if (other) {
    rightId.value = other.id;
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
        v-if="canAddSecond"
        type="button"
        class="hdr-btn"
        title="Open a second connection (drag files between them)"
        @click="addSecond"
      >
        <Columns2 :size="14" />
      </button>
      <button type="button" class="hdr-btn" title="Hide file browser" @click="emit('close')">
        <X :size="14" />
      </button>
    </header>

    <div class="flex-1 min-h-0 flex">
      <SftpBrowser
        class="flex-1 min-w-0"
        :tab-id="leftId"
        :connections="connections"
        @update:tab-id="leftId = $event"
      />
      <template v-if="rightId !== null">
        <div class="w-px bg-border shrink-0" />
        <SftpBrowser
          class="flex-1 min-w-0"
          :tab-id="rightId"
          :connections="connections"
          can-close
          @update:tab-id="rightId = $event"
          @close="rightId = null"
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
