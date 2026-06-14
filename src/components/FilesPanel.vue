<script setup lang="ts">
import { computed, watch } from "vue";
import { Columns2, X } from "lucide-vue-next";

import { getPanelColumns, type PanelSource as Source } from "../state/filesPanel";
import { listSshConnections, listWorkspaceTerminals } from "../state/tabs";
import { workspaceTick } from "../state/workspace";
import LocalBrowser from "./LocalBrowser.vue";
import SftpBrowser from "./SftpBrowser.vue";

// Unified file panel: one or two columns, each showing either the local file
// browser or one SSH connection's SFTP browser (any combination — drag between
// them to upload/download/relay). Hosted either as a workspace panel pane
// (`paneId` set — see state/panels.ts) or as the full-width view of an
// SFTP-only tab (`paneId` unset, `seedSshTabId` = that tab).
//
// `seedSshTabId` seeds the left column with that connection (local files
// otherwise); `seedPath` seeds the local column's starting folder. The local
// browser's cd / insert-path picks a target terminal from `terminals` (its
// row menu's submenu), defaulting to `defaultTargetTabId` for single clicks.
//
// Column state lives in `state/filesPanel.ts`, keyed per panel instance —
// switching to another tab unmounts this panel entirely, and each instance's
// single/dual layout should still be there when the user comes back.

const props = defineProps<{
  /** Workspace panel pane id (stable identity for column state). */
  paneId?: number | null;
  /** Workspace slot hosting this panel — source of the terminal list for the
   *  cd / insert-path target picker. */
  slotId?: number | null;
  /** SSH connection to seed the left column with (local files otherwise). */
  seedSshTabId?: number | null;
  /** Initial folder for the local column (seeded from a terminal's cwd). */
  seedPath?: string | null;
  /** Terminal to seed the cd / insert-path target picker with. */
  seedTargetTabId?: number | null;
  /** Full-width mode (SFTP-only tabs): no terminal to reclaim, so no close
   *  affordance — and no left border, the panel isn't docked to anything. */
  hideClose?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

// ---- cd / insert-path target terminals -------------------------------------
// Self-contained: the local browser's "cd here / insert path" context-menu
// items list these terminals as a submenu (the workspace's terminal panes;
// empty in full-width SFTP-only mode). `defaultTargetTabId` is the implicit
// target for a single-click path insert — the terminal the panel was opened
// from, else the focused / first pane.
const terminals = computed(() => {
  void workspaceTick.value;
  return props.slotId != null ? listWorkspaceTerminals(props.slotId) : [];
});
const defaultTargetTabId = computed<number | null>(() => {
  const list = terminals.value;
  if (props.seedTargetTabId != null && list.some((t) => t.id === props.seedTargetTabId))
    return props.seedTargetTabId;
  return list.find((t) => t.focused)?.id ?? list[0]?.id ?? null;
});

const cols = computed(() =>
  getPanelColumns(
    props.paneId != null ? `pane:${props.paneId}` : `ssh:${props.seedSshTabId}`,
    props.seedSshTabId ?? "local",
  ),
);
const left = computed<Source>({
  get: () => cols.value.left.value,
  set: (v) => {
    cols.value.left.value = v;
  },
});
const right = computed<Source | null>({
  get: () => cols.value.right.value,
  set: (v) => {
    cols.value.right.value = v;
  },
});

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
// the panel was unmounted, with stale ids persisted in the column store. Also
// re-runs when the panel retargets to another tab's column set.
watch(
  [connections, cols] as const,
  ([list]) => {
    const valid = (s: Source) => s === "local" || list.some((c) => c.id === s);
    if (right.value !== null && !valid(right.value)) right.value = null;
    if (!valid(left.value)) {
      if (right.value !== null) {
        // Left connection died: promote the right column instead of showing a
        // dead pane.
        left.value = right.value;
        right.value = null;
      } else {
        left.value =
          props.seedSshTabId != null &&
          list.some((c) => c.id === props.seedSshTabId)
            ? props.seedSshTabId
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
}
</script>

<template>
  <aside
    class="flex flex-col min-h-0 self-stretch bg-surface-1 text-fg"
    :class="hideClose ? '' : 'border-l border-border'"
  >
    <div class="flex-1 min-h-0 flex">
      <LocalBrowser
        v-if="left === 'local'"
        class="flex-1 min-w-0"
        :targets="terminals"
        :default-target-tab-id="defaultTargetTabId"
        :seed-path="seedPath"
        :sources="sources"
        source-value="local"
        @update:source="left = decode($event)"
      >
        <template #actions>
          <button
            v-if="canAddSecond"
            type="button"
            class="hdr-btn"
            title="Open a second column (drag files between them)"
            @click="addSecond"
          >
            <Columns2 :size="14" />
          </button>
          <button
            v-if="!hideClose"
            type="button"
            class="hdr-btn"
            title="Hide file browser"
            @click="emit('close')"
          >
            <X :size="14" />
          </button>
        </template>
      </LocalBrowser>
      <SftpBrowser
        v-else
        class="flex-1 min-w-0"
        :tab-id="left"
        :sources="sources"
        :source-value="encode(left)"
        @update:source="left = decode($event)"
      >
        <template #actions>
          <button
            v-if="canAddSecond"
            type="button"
            class="hdr-btn"
            title="Open a second column (drag files between them)"
            @click="addSecond"
          >
            <Columns2 :size="14" />
          </button>
          <button
            v-if="!hideClose"
            type="button"
            class="hdr-btn"
            title="Hide file browser"
            @click="emit('close')"
          >
            <X :size="14" />
          </button>
        </template>
      </SftpBrowser>
      <template v-if="right !== null">
        <div class="w-px bg-border shrink-0" />
        <LocalBrowser
          v-if="right === 'local'"
          class="flex-1 min-w-0"
          :targets="terminals"
          :default-target-tab-id="defaultTargetTabId"
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
