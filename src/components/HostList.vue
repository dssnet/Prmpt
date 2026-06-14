<script setup lang="ts">
import {
  AlertTriangle,
  ChevronDown,
  Combine,
  Copy,
  FolderOpen,
  FolderPlus,
  Info,
  KeyRound,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  Server,
  Settings,
  Terminal,
  Trash2,
} from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { useDomScroll } from "../composables/useDomScroll";
import {
  clearHostPasswordFlag,
  deleteGroup,
  deleteHost,
  duplicateHost,
  listGroups,
  listHosts,
  saveGroup,
  setGroupHidden,
  setGroupOpen,
  type SshGroupRow,
  type SshHostRow,
} from "../db";
import { buildGroupTree, concealedGroupIds, descendantGroupIds } from "../lib/groupTree";
import {
  deleteSecret,
  hostPasswordKey,
  loadSecret,
  saveSecret,
} from "../secrets";
import { connectHost, defaultConnectMode, type ConnectMode } from "../state/connect";
import GroupTree from "./GroupTree.vue";
import HidePinDialogs from "./HidePinDialogs.vue";
import {
  ActionMenu,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Scrollbar,
} from "./ui";

const emit = defineEmits<{
  addHost: [];
  editHost: [host: SshHostRow];
  manageKeys: [];
  openSettings: [];
}>();

const hosts = ref<SshHostRow[]>([]);
const groups = ref<SshGroupRow[]>([]);
const errorText = ref<string | null>(null);
const connecting = ref<number | null>(null);

// null === "All hosts". Otherwise the selected group id.
const selectedGroupId = ref<number | null>(null);
const expanded = ref<Set<number>>(new Set());

// Hidden-group lock. `locked` starts true every session so hidden groups stay
// concealed until the PIN is entered; `pinSet` controls whether the lock
// affordance is shown at all (it appears once the user has set a PIN).
const locked = ref(true);
const pinSet = ref(false);

const scrollRoot = ref<HTMLElement | null>(null);
const { position, range, viewportSize, onScrollTo, onPageBy } =
  useDomScroll(scrollRoot);

// Resizeable sidebar. Width is stored as a percentage of the home-tab width
// (so it scales across window sizes) and persisted per-machine in localStorage.
const SIDEBAR_KEY = "prmpt.homeSidebarWidthPct";
const MIN_PCT = 12;
const MAX_PCT = 40;
const DEFAULT_PCT = 20;
const sidebarPct = ref<number>(DEFAULT_PCT);
const containerRef = ref<HTMLElement | null>(null);

function clampPct(n: number): number {
  return Math.min(MAX_PCT, Math.max(MIN_PCT, n));
}

let dragRaf = 0;
let pendingDragEvent: MouseEvent | null = null;

function onSidebarDragMove(e: MouseEvent) {
  pendingDragEvent = e;
  if (dragRaf) return;
  dragRaf = requestAnimationFrame(() => {
    dragRaf = 0;
    const ev = pendingDragEvent;
    const el = containerRef.value;
    if (!ev || !el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    sidebarPct.value = clampPct(((ev.clientX - rect.left) / rect.width) * 100);
  });
}

function onSidebarDragEnd() {
  window.removeEventListener("mousemove", onSidebarDragMove);
  window.removeEventListener("mouseup", onSidebarDragEnd);
  if (dragRaf) {
    cancelAnimationFrame(dragRaf);
    dragRaf = 0;
  }
  pendingDragEvent = null;
  document.body.style.userSelect = "";
  localStorage.setItem(SIDEBAR_KEY, String(Math.round(sidebarPct.value)));
}

function onSidebarDragStart(e: MouseEvent) {
  e.preventDefault();
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", onSidebarDragMove);
  window.addEventListener("mouseup", onSidebarDragEnd);
}

onBeforeUnmount(onSidebarDragEnd);

// While locked, hidden groups (and their subtrees) are concealed entirely.
const concealed = computed(() =>
  locked.value ? concealedGroupIds(groups.value) : new Set<number>(),
);

const groupTree = computed(() =>
  buildGroupTree(groups.value.filter((g) => !concealed.value.has(g.id))),
);

const visibleHosts = computed(() => {
  let list = hosts.value;
  if (concealed.value.size > 0) {
    list = list.filter((h) => h.group_id == null || !concealed.value.has(h.group_id));
  }
  if (selectedGroupId.value == null) return list;
  const ids = descendantGroupIds(groups.value, selectedGroupId.value);
  return list.filter((h) => h.group_id != null && ids.has(h.group_id));
});

const selectedGroupLabel = computed(() =>
  selectedGroupId.value == null
    ? "All hosts"
    : (groups.value.find((g) => g.id === selectedGroupId.value)?.label ?? "All hosts"),
);

async function refresh() {
  errorText.value = null;
  try {
    [hosts.value, groups.value] = await Promise.all([listHosts(), listGroups()]);
    // Mirror the persisted expand/collapse state into the live set.
    expanded.value = new Set(groups.value.filter((g) => g.open).map((g) => g.id));
    // Drop a stale selection if its group was deleted or is now concealed.
    if (
      selectedGroupId.value != null &&
      (!groups.value.some((g) => g.id === selectedGroupId.value) ||
        concealed.value.has(selectedGroupId.value))
    ) {
      selectedGroupId.value = null;
    }
  } catch (err) {
    console.error("refresh failed:", err);
    errorText.value = `Failed to load hosts: ${err}`;
  }
}

onMounted(async () => {
  const saved = parseFloat(localStorage.getItem(SIDEBAR_KEY) ?? "");
  if (Number.isFinite(saved)) sidebarPct.value = clampPct(saved);
  await refresh();
});
defineExpose({ refresh });

async function onConnect(h: SshHostRow, mode?: ConnectMode) {
  connecting.value = h.id;
  try {
    await connectHost(h, mode);
  } catch (err) {
    console.error("connect failed:", err);
    errorText.value = `Connect failed: ${err}`;
  } finally {
    connecting.value = null;
  }
}

const duplicating = ref<number | null>(null);
const advancedHost = ref<SshHostRow | null>(null);

async function onDuplicate(h: SshHostRow) {
  duplicating.value = h.id;
  try {
    const newId = await duplicateHost(h);
    // Carry the stored password over to the copy. If it can't be read
    // (locked/missing), clear the flag so the copy isn't marked broken.
    if (h.has_password) {
      try {
        const pw = await loadSecret(hostPasswordKey(h.id));
        if (pw != null) await saveSecret(hostPasswordKey(newId), pw);
        else await clearHostPasswordFlag(newId);
      } catch {
        await clearHostPasswordFlag(newId);
      }
    }
    await refresh();
  } catch (err) {
    console.error("duplicateHost failed:", err);
    errorText.value = `Duplicate failed: ${err}`;
  } finally {
    duplicating.value = null;
  }
}

const deleteHostTarget = ref<SshHostRow | null>(null);

function requestDeleteHost(h: SshHostRow) {
  deleteHostTarget.value = h;
}

async function confirmDeleteHost() {
  const h = deleteHostTarget.value;
  if (!h) return;
  try {
    await deleteHost(h.id);
    if (h.has_password) {
      await deleteSecret(hostPasswordKey(h.id)).catch(() => undefined);
    }
    deleteHostTarget.value = null;
    await refresh();
  } catch (err) {
    console.error("deleteHost failed:", err);
    errorText.value = `Delete failed: ${err}`;
    deleteHostTarget.value = null;
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

// ---------- group tree interactions ----------

function toggleGroup(id: number) {
  const willOpen = !expanded.value.has(id);
  if (willOpen) expanded.value.add(id);
  else expanded.value.delete(id);
  void setGroupOpen(id, willOpen).catch((err) =>
    console.error("setGroupOpen failed:", err),
  );
}

// ---------- hide / PIN lock ----------

// The PIN dialogs live in <HidePinDialogs>; this component drives them
// imperatively and keeps `locked` / `pinSet` (bound via v-model) for the lock
// affordance and concealment logic.
const pinDialogs = ref<InstanceType<typeof HidePinDialogs> | null>(null);

// When the user hides a group before any PIN exists, remember which group to
// hide once the new PIN is saved (see onPinCreated).
const pendingHideGroupId = ref<number | null>(null);

async function onToggleHidden(group: SshGroupRow) {
  // First time hiding anything: require a PIN to be set first.
  if (!group.hidden && !pinSet.value) {
    pendingHideGroupId.value = group.id;
    pinDialogs.value?.openSetPin();
    return;
  }
  try {
    await setGroupHidden(group.id, !group.hidden);
    await refresh();
  } catch (err) {
    console.error("setGroupHidden failed:", err);
    errorText.value = `Hide failed: ${err}`;
  }
}

// A brand-new PIN was just created; hide the group that triggered it.
async function onPinCreated() {
  try {
    if (pendingHideGroupId.value != null) {
      await setGroupHidden(pendingHideGroupId.value, true);
      pendingHideGroupId.value = null;
    }
    await refresh();
  } catch (err) {
    console.error("setGroupHidden failed:", err);
    errorText.value = `Hide failed: ${err}`;
  }
}

function onLockClick() {
  if (locked.value) {
    pinDialogs.value?.openUnlock();
  } else {
    // Re-lock: conceal hidden groups again and drop a now-hidden selection.
    locked.value = true;
    if (
      selectedGroupId.value != null &&
      concealedGroupIds(groups.value).has(selectedGroupId.value)
    ) {
      selectedGroupId.value = null;
    }
  }
}

// ---------- group create / rename modal ----------

type GroupModalMode = "create-top" | "create-sub" | "rename";

const groupModalOpen = ref(false);
const groupModalMode = ref<GroupModalMode>("create-top");
const groupModalLabel = ref("");
const groupModalParentId = ref<number | null>(null);
const groupModalEditId = ref<number | null>(null);
const groupSaving = ref(false);

const groupModalTitle = computed(() =>
  groupModalMode.value === "rename"
    ? "Rename group"
    : groupModalMode.value === "create-sub"
      ? "New subgroup"
      : "New group",
);

function openCreateTop() {
  groupModalMode.value = "create-top";
  groupModalLabel.value = "";
  groupModalParentId.value = null;
  groupModalEditId.value = null;
  groupModalOpen.value = true;
}

function openCreateSub(parentId: number) {
  groupModalMode.value = "create-sub";
  groupModalLabel.value = "";
  groupModalParentId.value = parentId;
  groupModalEditId.value = null;
  expanded.value.add(parentId); // reveal the new child once saved
  groupModalOpen.value = true;
}

function openRename(group: SshGroupRow) {
  groupModalMode.value = "rename";
  groupModalLabel.value = group.label;
  groupModalParentId.value = group.parent_id;
  groupModalEditId.value = group.id;
  groupModalOpen.value = true;
}

function closeGroupModal() {
  groupModalOpen.value = false;
}

async function submitGroupModal() {
  const label = groupModalLabel.value.trim();
  if (!label) return;
  groupSaving.value = true;
  try {
    await saveGroup({
      id: groupModalEditId.value,
      label,
      parent_id: groupModalParentId.value,
    });
    groupModalOpen.value = false;
    await refresh();
  } catch (err) {
    console.error("saveGroup failed:", err);
    errorText.value = `Save group failed: ${err}`;
  } finally {
    groupSaving.value = false;
  }
}

// ---------- group delete ----------

const deleteGroupTarget = ref<SshGroupRow | null>(null);

function requestDeleteGroup(group: SshGroupRow) {
  deleteGroupTarget.value = group;
}

async function confirmDeleteGroup() {
  const g = deleteGroupTarget.value;
  if (!g) return;
  try {
    await deleteGroup(g.id);
    if (selectedGroupId.value === g.id) selectedGroupId.value = null;
    deleteGroupTarget.value = null;
    await refresh();
  } catch (err) {
    console.error("deleteGroup failed:", err);
    errorText.value = `Delete group failed: ${err}`;
  }
}
</script>

<template>
  <div ref="containerRef" class="absolute inset-0 flex text-fg">
    <!-- Sidebar: group tree (floating card, like the host entries) -->
    <aside
      class="flex-none my-4 ml-4 flex flex-col border border-border rounded-lg bg-surface-1 overflow-hidden"
      :style="{ width: sidebarPct + '%' }"
    >
      <!-- All hosts, separated from the group tree below. -->
      <div class="flex items-center gap-1 px-2 py-2 flex-none border-b border-border">
        <div
          class="flex items-center gap-1.5 flex-1 min-w-0 px-1.5 py-1 rounded-md cursor-pointer transition-colors duration-150"
          :class="
            selectedGroupId == null
              ? 'bg-surface-3 text-fg'
              : 'text-fg-muted hover:text-fg hover:bg-surface-2'
          "
          @click="selectedGroupId = null"
        >
          <Server :size="14" class="shrink-0" />
          <span class="flex-1 min-w-0 truncate text-sm font-medium">All hosts</span>
        </div>
        <button
          v-if="pinSet"
          type="button"
          :title="locked ? 'Locked — click to reveal hidden groups' : 'Unlocked — click to hide again'"
          :aria-label="locked ? 'Unlock hidden groups' : 'Lock hidden groups'"
          class="shrink-0 grid place-items-center w-7 h-7 rounded-md cursor-pointer transition-colors duration-150"
          :class="
            locked
              ? 'text-fg-muted hover:text-fg hover:bg-surface-2'
              : 'text-accent hover:bg-surface-2'
          "
          @click="onLockClick"
        >
          <!-- Lucide's lock ink is bottom-heavy in its viewBox (shackle gap at
               the top); nudge up 1px so it optically centers like FolderPlus. -->
          <Lock v-if="locked" :size="15" class="relative -top-px" />
          <LockOpen v-else :size="15" class="relative -top-px" />
        </button>
        <button
          type="button"
          title="Add group"
          aria-label="Add group"
          class="shrink-0 grid place-items-center w-7 h-7 rounded-md text-fg-muted hover:text-fg hover:bg-surface-2 cursor-pointer transition-colors duration-150"
          @click="openCreateTop"
        >
          <FolderPlus :size="15" />
        </button>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto px-2 py-2 flex flex-col gap-0.5">
        <GroupTree
          :nodes="groupTree"
          :selected-id="selectedGroupId"
          :expanded="expanded"
          @select="selectedGroupId = $event"
          @toggle="toggleGroup"
          @add-sub="openCreateSub"
          @rename="openRename"
          @delete="requestDeleteGroup"
          @toggle-hidden="onToggleHidden"
        />

        <div v-if="groups.length === 0" class="px-1.5 py-2 text-[11px] text-fg-subtle leading-relaxed">
          No groups yet. Use the
          <FolderPlus :size="11" class="inline align-text-bottom" />
          button to create one, then assign hosts to it from the host editor.
        </div>
      </div>

      <!-- Footer: settings -->
      <div class="flex-none border-t border-border p-2">
        <button
          type="button"
          title="Theme settings"
          aria-label="Open settings"
          class="w-full flex items-center gap-1.5 px-1.5 py-1.5 rounded-md text-fg-muted hover:text-fg hover:bg-surface-2 cursor-pointer transition-colors duration-150"
          @click="emit('openSettings')"
        >
          <Settings :size="15" class="shrink-0" />
          <span class="text-sm">Settings</span>
        </button>
      </div>
    </aside>

    <!-- Drag handle: resize the sidebar -->
    <div
      class="flex-none w-1 mx-0.5 self-stretch cursor-col-resize rounded-full hover:bg-accent/40 transition-colors"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      @mousedown="onSidebarDragStart"
    />

    <!-- Right column: filtered host list -->
    <div class="relative flex-1 min-w-0 h-full">
      <div ref="scrollRoot" class="absolute inset-0 flex flex-col gap-3.5 px-9 pt-2 pb-6 overflow-y-auto scrollbar-none">
        <PageHeader :title="selectedGroupLabel">
          <template #actions>
            <Button :icon="Plus" @click="emit('addHost')">Add host</Button>
            <Button variant="secondary" :icon="KeyRound" @click="emit('manageKeys')">Manage keys</Button>
          </template>
        </PageHeader>

        <div class="flex flex-col gap-2">
          <div
            v-for="h in visibleHosts"
            :key="h.id"
            class="flex items-center justify-between gap-3 px-3.5 py-3 border border-border rounded-lg bg-surface-1 hover:border-border-strong transition-colors duration-150"
          >
            <div class="flex flex-col gap-0.5 min-w-0 flex-1">
              <div class="font-medium text-fg flex items-center gap-1.5">
                <span>{{ h.label }}</span>
                <Badge
                  v-if="h.disable_ssh"
                  title="SFTP-only host — connecting opens the file browser, no terminal."
                >SFTP</Badge>
                <AlertTriangle
                  v-if="h.broken"
                  :size="14"
                  class="text-danger shrink-0 cursor-help"
                  title="Stored credentials could not be unlocked. Edit this host to re-enter the password."
                />
              </div>
              <div class="text-xs text-fg-muted font-mono">{{ h.username }}@{{ h.hostname }}:{{ h.port }}</div>
            </div>
            <div class="flex gap-1.5">
              <div class="inline-flex items-stretch">
              <button
                type="button"
                :disabled="h.broken || connecting === h.id"
                class="inline-flex items-center justify-center px-2.5 py-1 text-xs border border-accent border-r-0 bg-accent text-bg rounded-l-md hover:opacity-90 disabled:opacity-50 disabled:cursor-default cursor-pointer transition-opacity duration-150"
                @click="onConnect(h)"
              >
                Connect
              </button>
              <ActionMenu title="Connection options" class="flex">
                <template #trigger="{ open, toggle }">
                  <button
                    type="button"
                    title="Choose how to connect"
                    :aria-haspopup="'menu'"
                    :aria-expanded="open"
                    :disabled="h.broken || connecting === h.id"
                    class="inline-flex items-center justify-center px-1.5 py-1 border border-accent border-l-[color-mix(in_srgb,var(--color-bg)_22%,transparent)] bg-accent text-bg rounded-r-md hover:opacity-90 disabled:opacity-50 disabled:cursor-default cursor-pointer transition-opacity duration-150"
                    @click="toggle"
                  >
                    <ChevronDown :size="14" />
                  </button>
                </template>
                <template #default="{ close }">
                  <button
                    type="button"
                    role="menuitem"
                    class="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md whitespace-nowrap text-fg hover:bg-surface-2 cursor-pointer transition-colors duration-150"
                    @click="onConnect(h, 'shell'); close()"
                  >
                    <Terminal :size="14" class="shrink-0 text-fg-muted" /> Shell
                    <span v-if="defaultConnectMode(h) === 'shell'" class="ml-auto text-[10px] text-fg-muted">default</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    class="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md whitespace-nowrap text-fg hover:bg-surface-2 cursor-pointer transition-colors duration-150"
                    @click="onConnect(h, 'sftp'); close()"
                  >
                    <FolderOpen :size="14" class="shrink-0 text-fg-muted" /> SFTP
                    <span v-if="defaultConnectMode(h) === 'sftp'" class="ml-auto text-[10px] text-fg-muted">default</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    class="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md whitespace-nowrap text-fg hover:bg-surface-2 cursor-pointer transition-colors duration-150"
                    @click="onConnect(h, 'both'); close()"
                  >
                    <Combine :size="14" class="shrink-0 text-fg-muted" /> Both
                    <span v-if="defaultConnectMode(h) === 'both'" class="ml-auto text-[10px] text-fg-muted">default</span>
                  </button>
                </template>
              </ActionMenu>
              </div>
              <ActionMenu title="Host actions">
                <template #default="{ close }">
                  <button
                    type="button"
                    role="menuitem"
                    class="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md whitespace-nowrap text-fg hover:bg-surface-2 cursor-pointer transition-colors duration-150"
                    @click="emit('editHost', h); close()"
                  >
                    <Pencil :size="14" class="shrink-0 text-fg-muted" /> Edit
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    :disabled="duplicating === h.id"
                    class="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md whitespace-nowrap text-fg hover:bg-surface-2 cursor-pointer transition-colors duration-150 disabled:opacity-50 disabled:cursor-default"
                    @click="onDuplicate(h); close()"
                  >
                    <Copy :size="14" class="shrink-0 text-fg-muted" /> Duplicate
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    class="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md whitespace-nowrap text-fg hover:bg-surface-2 cursor-pointer transition-colors duration-150"
                    @click="advancedHost = h; close()"
                  >
                    <Info :size="14" class="shrink-0 text-fg-muted" /> Show advanced infos
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    class="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md whitespace-nowrap text-danger hover:bg-[color-mix(in_srgb,var(--color-danger)_18%,transparent)] cursor-pointer transition-colors duration-150"
                    @click="requestDeleteHost(h); close()"
                  >
                    <Trash2 :size="14" class="shrink-0" /> Delete
                  </button>
                </template>
              </ActionMenu>
            </div>
          </div>
        </div>

        <EmptyState v-if="visibleHosts.length === 0 || errorText">
          {{
            errorText
              ?? (selectedGroupId == null
                ? "No SSH hosts yet. Click \"Add host\" to save your first connection."
                : `No hosts in "${selectedGroupLabel}" yet. Edit a host to assign it to this group.`)
          }}
        </EmptyState>
      </div>

      <!-- Custom scrollbar lives outside the scroll container so it stays
           pinned to the host pane rather than scrolling with the list. -->
      <Scrollbar
        :position="position"
        :range="range"
        :viewport-size="viewportSize"
        @scroll-to="onScrollTo"
        @page-by="onPageBy"
      />
    </div>

    <!-- Create / rename group -->
    <Modal v-if="groupModalOpen">
      <h2 class="m-0 text-base font-semibold text-fg">{{ groupModalTitle }}</h2>
      <form class="flex flex-col gap-3.5" @submit.prevent="submitGroupModal">
        <Input
          v-model="groupModalLabel"
          placeholder="Group name"
          autocomplete="off"
        />
        <div class="flex justify-end gap-2">
          <Button variant="secondary" @click="closeGroupModal">Cancel</Button>
          <Button type="submit" :disabled="groupSaving || !groupModalLabel.trim()">
            {{ groupModalMode === "rename" ? "Rename" : "Create" }}
          </Button>
        </div>
      </form>
    </Modal>

    <!-- Delete host -->
    <ConfirmDialog
      :open="deleteHostTarget != null"
      title="Delete host?"
      :message="deleteHostTarget ? `Delete “${deleteHostTarget.label}”? This removes the saved connection${deleteHostTarget.has_password ? ' and its stored password' : ''}.` : ''"
      confirm-label="Delete host"
      cancel-label="Cancel"
      @confirm="confirmDeleteHost"
      @cancel="deleteHostTarget = null"
    />

    <!-- Advanced host info -->
    <Modal v-if="advancedHost">
      <h2 class="m-0 text-base font-semibold text-fg">{{ advancedHost.label }}</h2>
      <dl class="m-0 flex flex-col gap-3 text-sm">
        <div class="flex flex-col gap-0.5">
          <dt class="text-xs uppercase tracking-wide text-fg-subtle">Connection</dt>
          <dd class="m-0 font-mono text-fg-muted">
            {{ advancedHost.username }}@{{ advancedHost.hostname }}:{{ advancedHost.port }}
          </dd>
        </div>
        <div class="flex flex-col gap-1">
          <dt class="text-xs uppercase tracking-wide text-fg-subtle">Authentication</dt>
          <dd class="m-0"><Badge>{{ badgeText(advancedHost) }}</Badge></dd>
        </div>
        <div class="flex flex-col gap-0.5">
          <dt class="text-xs uppercase tracking-wide text-fg-subtle">Host key signature</dt>
          <dd
            v-if="advancedHost.host_fp_sha256"
            class="m-0 font-mono text-xs text-fg-muted break-all"
          >
            {{ advancedHost.host_key_alg ? advancedHost.host_key_alg + " " : "" }}{{ advancedHost.host_fp_sha256 }}
          </dd>
          <dd v-else class="m-0 text-xs text-fg-subtle">
            Not recorded yet — pinned on first connect.
          </dd>
        </div>
      </dl>
      <div class="flex justify-end gap-2 mt-1">
        <Button variant="secondary" @click="advancedHost = null">Close</Button>
      </div>
    </Modal>

    <!-- Delete group -->
    <Modal v-if="deleteGroupTarget" title="Delete group?">
      <p class="m-0 text-sm text-fg-muted leading-relaxed">
        Delete <span class="text-fg font-medium">"{{ deleteGroupTarget.label }}"</span>?
        Its hosts and subgroups will move up one level — nothing is deleted with it.
      </p>
      <div class="flex justify-end gap-2 mt-1">
        <Button variant="secondary" @click="deleteGroupTarget = null">Cancel</Button>
        <Button variant="danger" @click="confirmDeleteGroup">Delete group</Button>
      </div>
    </Modal>

    <HidePinDialogs
      ref="pinDialogs"
      v-model:locked="locked"
      v-model:pin-set="pinSet"
      @pin-created="onPinCreated"
    />
  </div>
</template>
