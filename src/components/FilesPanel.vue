<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { X } from "lucide-vue-next";

import { listHosts, type SshHostRow } from "../db";
import { getPanelColumns, type PanelSource as Source } from "../state/filesPanel";
import { listWorkspaceTerminals } from "../state/tabs";
import { acquireSftpForPane, releaseSftpForPane } from "../state/sftpConsumers";
import { showToast } from "../state/toasts";
import { workspaceTick } from "../state/workspace";
import LocalBrowser from "./LocalBrowser.vue";
import SftpBrowser from "./SftpBrowser.vue";

// File panel: a single browser showing either the local file browser or one
// saved host's SFTP browser, with a picker (local + every saved host) to
// switch between them. For side-by-side browsing (drag files between two
// locations) just tile a second file panel in the workspace. Hosted as a
// workspace panel pane (`paneId` set — see state/panels.ts).
//
// Selecting a host acquires this panel's own SFTP *consumer* on the host's
// pooled connection (`acquireSftpForPane`), independent of any terminal — the
// returned consumer id routes every `sftp_*` call (passed to SftpBrowser as
// `tab-id`). The consumer is tied to the pane's lifetime: it survives a tab
// switch (which unmounts the panel) and is released only on a source switch or
// when the pane closes (state/tabs `closePanelLeaf` / workspace teardown).
//
// `seedHostId` seeds the source to a host; `seedPath` seeds the local
// browser's starting folder. The chosen source lives in `state/filesPanel.ts`,
// keyed per panel instance, so it persists across the panel unmounting.

const props = defineProps<{
  /** Workspace panel pane id (stable identity for column + consumer state). */
  paneId?: number | null;
  /** Workspace slot hosting this panel — source of the terminal list for the
   *  cd / insert-path target picker. */
  slotId?: number | null;
  /** Saved host to seed the source with (local files otherwise). */
  seedHostId?: number | null;
  /** Initial folder for the local column (seeded from a terminal's cwd). */
  seedPath?: string | null;
  /** Terminal to seed the cd / insert-path target picker with. */
  seedTargetTabId?: number | null;
  /** Full-width mode: no terminal to reclaim, so no close affordance — and no
   *  left border, the panel isn't docked to anything. */
  hideClose?: boolean;
}>();
const emit = defineEmits<{ close: []; "update:title": [string] }>();

// ---- cd / insert-path target terminals -------------------------------------
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

// ---- source (local | host id) ----------------------------------------------
const cols = computed(() =>
  getPanelColumns(
    props.paneId != null ? `pane:${props.paneId}` : `host:${props.seedHostId}`,
    props.seedHostId ?? "local",
  ),
);
const source = computed<Source>({
  get: () => cols.value.source.value,
  set: (v) => {
    cols.value.source.value = v;
  },
});

// Saved hosts for the picker. All are SFTP-capable ("Shell only" hosts open
// the subsystem lazily). Loaded once on mount; an empty list (not yet loaded)
// suppresses source-validity demotion below.
const hosts = ref<SshHostRow[]>([]);
onMounted(async () => {
  try {
    hosts.value = await listHosts();
  } catch {
    /* ignore — picker just shows local until hosts load */
  }
});

const sources = computed(() => [
  { value: "local", label: "Local files" },
  ...hosts.value.map((h) => ({ value: `sftp:${h.id}`, label: h.label })),
]);

function encode(s: Source): string {
  return s === "local" ? "local" : `sftp:${s}`;
}
function decode(v: string): Source {
  return v === "local" ? "local" : Number(v.slice("sftp:".length));
}

// ---- SFTP consumer lifecycle ------------------------------------------------
// `consumerId` is the routing id for SftpBrowser; null while connecting or on
// local. Acquired when the source is a host, released when it switches to
// local / another host. The pane-level release on close lives in state/tabs.
const consumerId = ref<number | null>(null);

watch(
  [source, () => props.paneId] as const,
  async ([s, paneId]) => {
    if (paneId == null) return;
    if (s === "local") {
      releaseSftpForPane(paneId);
      consumerId.value = null;
      return;
    }
    const hostId = s;
    consumerId.value = null;
    try {
      const id = await acquireSftpForPane(paneId, hostId);
      // Guard against a source change while we were acquiring.
      if (source.value === hostId) consumerId.value = id;
    } catch (e) {
      if (source.value === hostId) {
        showToast(
          {
            host: hosts.value.find((h) => h.id === hostId)?.label ?? "remote host",
            title: "Couldn't open file browser",
            detail: e instanceof Error ? e.message : String(e),
            kind: "error",
          },
          6000,
        );
        source.value = "local";
      }
    }
  },
  { immediate: true },
);

// Report the pane title: the current source (local, or the host's label).
// Falls back to "Remote files" until the host list resolves a label.
const paneTitle = computed(() => {
  const s = source.value;
  if (s === "local") return "Local files";
  return hosts.value.find((h) => h.id === s)?.label ?? "Remote files";
});
watch(paneTitle, (t) => emit("update:title", t), { immediate: true });

// Repair the source when its host is deleted (e.g. removed in the host
// manager). Skipped until hosts have loaded so a freshly-seeded host isn't
// demoted before the list arrives.
watch(
  [hosts, source] as const,
  ([list, s]) => {
    if (s === "local" || list.length === 0) return;
    if (!list.some((h) => h.id === s)) source.value = "local";
  },
);
</script>

<template>
  <aside
    class="flex flex-col min-h-0 self-stretch bg-surface-1 text-fg"
    :class="hideClose ? '' : 'border-l border-border'"
  >
    <div class="flex-1 min-h-0 flex">
      <LocalBrowser
        v-if="source === 'local'"
        class="flex-1 min-w-0"
        :targets="terminals"
        :default-target-tab-id="defaultTargetTabId"
        :seed-path="seedPath"
        :sources="sources"
        source-value="local"
        @update:source="source = decode($event)"
      >
        <template #actions>
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
        v-else-if="consumerId != null"
        class="flex-1 min-w-0"
        :tab-id="consumerId"
        :sources="sources"
        :source-value="encode(source)"
        @update:source="source = decode($event)"
      >
        <template #actions>
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
      <div
        v-else
        class="flex-1 min-w-0 flex items-center justify-center text-fg-subtle text-sm"
      >
        Connecting…
      </div>
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
