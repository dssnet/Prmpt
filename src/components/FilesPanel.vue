<script setup lang="ts">
import { computed, watch } from "vue";
import { Columns2, X } from "lucide-vue-next";

import { panelColumns, type PanelSource as Source } from "../state/filesPanel";
import { listSshConnections } from "../state/tabs";
import { workspaceTick } from "../state/workspace";
import LocalBrowser from "./LocalBrowser.vue";
import SftpBrowser from "./SftpBrowser.vue";

// Unified file panel: one or two columns, each showing either the local file
// browser or one SSH connection's SFTP browser (any combination — drag between
// them to upload/download/relay). `tabId` is the focused tab: for `kind:
// "ssh"` it seeds the left column with that connection and the left column
// follows focus; for `kind: "terminal"` the left column starts on local files
// and `tabId` is the terminal the local browser targets for cd / insert-path.
//
// Column state lives in `state/filesPanel.ts`: switching to another tab
// unmounts this panel entirely, and the dual-pane layout should still be
// there when the user comes back.

const props = defineProps<{ tabId: number; kind: "ssh" | "terminal" }>();
const emit = defineEmits<{ close: []; expand: [] }>();

const cols = panelColumns[props.kind];
const { left, right } = cols;
if (!cols.seeded) {
  cols.seeded = true;
  left.value = props.kind === "ssh" ? props.tabId : "local";
}

watch(
  () => props.tabId,
  (v) => {
    if (props.kind !== "ssh") return;
    if (v === left.value) return;
    // Focusing the connection shown on the right (e.g. clicking its workspace
    // pane) swaps the columns instead of collapsing the dual view.
    if (v === right.value) {
      right.value = left.value;
      left.value = v;
      return;
    }
    // Follow focus in the first SFTP column; don't displace a local column.
    if (left.value !== "local") left.value = v;
    else if (right.value !== null && right.value !== "local") right.value = v;
  },
  // Re-sync on remount: focus may have moved to another connection while the
  // panel was unmounted.
  { immediate: true },
);

// All SSH connections that offer SFTP, for the per-column pickers.
const connections = computed(() => {
  void workspaceTick.value;
  return listSshConnections()
    .filter((c) => !c.disableSftp)
    .map((c) => ({ id: c.id, label: c.label }));
});

// Picker entries shared by both columns: local files + every connection.
const sources = computed(() => [
  { value: "local", label: "Local files" },
  ...connections.value.map((c) => ({ value: `sftp:${c.id}`, label: c.label })),
]);

function encode(s: Source): string {
  return s === "local" ? "local" : `sftp:${s}`;
}
function decode(v: string): Source {
  return v === "local" ? "local" : Number(v.slice("sftp:".length));
}

// Collapse or repair columns when a shown connection goes away (e.g. the user
// closes one of the SSH tabs). Immediate: connections may have closed while
// the panel was unmounted, with stale ids persisted in the column store.
watch(
  connections,
  (list) => {
    const valid = (s: Source) => s === "local" || list.some((c) => c.id === s);
    if (right.value !== null && !valid(right.value)) right.value = null;
    if (!valid(left.value)) {
      if (right.value !== null) {
        // Left connection died: promote the right column instead of showing a
        // dead pane.
        left.value = right.value;
        right.value = null;
      } else {
        left.value = list.some((c) => c.id === props.tabId)
          ? props.tabId
          : "local";
      }
    }
  },
  { immediate: true },
);

// A second column can always show local files; a dual-local view is pointless,
// so a local-only left needs at least one connection before offering it.
const canAddSecond = computed(
  () =>
    right.value === null &&
    (left.value !== "local" || connections.value.length >= 1),
);

function addSecond(): void {
  if (left.value === "local") {
    const first = connections.value[0];
    if (!first) return;
    right.value = first.id;
  } else {
    const other = connections.value.find((c) => c.id !== left.value);
    right.value = other ? other.id : "local";
  }
  emit("expand"); // ask the host to widen the panel for two columns
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
        title="Open a second column (drag files between them)"
        @click="addSecond"
      >
        <Columns2 :size="14" />
      </button>
      <button type="button" class="hdr-btn" title="Hide file browser" @click="emit('close')">
        <X :size="14" />
      </button>
    </header>

    <div class="flex-1 min-h-0 flex">
      <LocalBrowser
        v-if="left === 'local'"
        class="flex-1 min-w-0"
        :target-tab-id="tabId"
        :sources="sources"
        source-value="local"
        @update:source="left = decode($event)"
      />
      <SftpBrowser
        v-else
        class="flex-1 min-w-0"
        :tab-id="left"
        :sources="sources"
        :source-value="encode(left)"
        @update:source="left = decode($event)"
      />
      <template v-if="right !== null">
        <div class="w-px bg-border shrink-0" />
        <LocalBrowser
          v-if="right === 'local'"
          class="flex-1 min-w-0"
          :target-tab-id="tabId"
          :sources="sources"
          source-value="local"
          can-close
          @update:source="right = decode($event)"
          @close="right = null"
        />
        <SftpBrowser
          v-else
          class="flex-1 min-w-0"
          :tab-id="right"
          :sources="sources"
          :source-value="encode(right)"
          can-close
          @update:source="right = decode($event)"
          @close="right = null"
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
