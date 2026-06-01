<script setup lang="ts">
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-vue-next";

import type { SshGroupRow } from "../db";
import type { GroupNode } from "../lib/groupTree";

withDefaults(
  defineProps<{
    nodes: GroupNode[];
    selectedId: number | null;
    expanded: Set<number>;
    depth?: number;
  }>(),
  { depth: 0 },
);

const emit = defineEmits<{
  select: [id: number];
  toggle: [id: number];
  addSub: [parentId: number];
  rename: [group: SshGroupRow];
  delete: [group: SshGroupRow];
  toggleHidden: [group: SshGroupRow];
}>();
</script>

<template>
  <ul class="m-0 p-0 list-none flex flex-col">
    <li v-for="node in nodes" :key="node.group.id">
      <div
        class="group/row flex items-center gap-1 pr-1 py-1 rounded-md cursor-pointer transition-colors duration-150"
        :class="
          selectedId === node.group.id
            ? 'bg-surface-3 text-fg'
            : 'text-fg-muted hover:text-fg hover:bg-surface-2'
        "
        :style="{ paddingLeft: `${depth * 14 + 4}px` }"
        @click="emit('select', node.group.id)"
      >
        <!-- expand/collapse toggle, reserved width even when childless -->
        <button
          v-if="node.children.length"
          type="button"
          class="shrink-0 grid place-items-center w-4 h-4 rounded text-fg-subtle hover:text-fg cursor-pointer"
          :title="expanded.has(node.group.id) ? 'Collapse' : 'Expand'"
          @click.stop="emit('toggle', node.group.id)"
        >
          <ChevronDown v-if="expanded.has(node.group.id)" :size="13" />
          <ChevronRight v-else :size="13" />
        </button>
        <span v-else class="shrink-0 w-4 h-4" aria-hidden="true" />

        <FolderOpen
          v-if="node.children.length && expanded.has(node.group.id)"
          :size="14"
          class="shrink-0"
          :class="{ 'opacity-60': node.group.hidden }"
        />
        <Folder v-else :size="14" class="shrink-0" :class="{ 'opacity-60': node.group.hidden }" />

        <span class="flex-1 min-w-0 truncate text-sm" :class="{ 'opacity-60 italic': node.group.hidden }">
          {{ node.group.label }}
        </span>
        <EyeOff
          v-if="node.group.hidden"
          :size="12"
          class="shrink-0 text-fg-subtle"
          title="Hidden — revealed because the sidebar is unlocked"
        />

        <!-- hover actions -->
        <span class="flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity duration-150">
          <button
            type="button"
            class="grid place-items-center w-5 h-5 rounded text-fg-subtle hover:text-fg hover:bg-surface-3 cursor-pointer"
            :title="node.group.hidden ? 'Unhide group' : 'Hide group'"
            @click.stop="emit('toggleHidden', node.group)"
          >
            <Eye v-if="node.group.hidden" :size="13" />
            <EyeOff v-else :size="13" />
          </button>
          <button
            type="button"
            class="grid place-items-center w-5 h-5 rounded text-fg-subtle hover:text-fg hover:bg-surface-3 cursor-pointer"
            title="Add subgroup"
            @click.stop="emit('addSub', node.group.id)"
          >
            <FolderPlus :size="13" />
          </button>
          <button
            type="button"
            class="grid place-items-center w-5 h-5 rounded text-fg-subtle hover:text-fg hover:bg-surface-3 cursor-pointer"
            title="Rename group"
            @click.stop="emit('rename', node.group)"
          >
            <Pencil :size="13" />
          </button>
          <button
            type="button"
            class="grid place-items-center w-5 h-5 rounded text-fg-subtle hover:text-danger hover:bg-surface-3 cursor-pointer"
            title="Delete group"
            @click.stop="emit('delete', node.group)"
          >
            <Trash2 :size="13" />
          </button>
        </span>
      </div>

      <!-- children -->
      <GroupTree
        v-if="node.children.length && expanded.has(node.group.id)"
        :nodes="node.children"
        :selected-id="selectedId"
        :expanded="expanded"
        :depth="depth + 1"
        @select="emit('select', $event)"
        @toggle="emit('toggle', $event)"
        @add-sub="emit('addSub', $event)"
        @rename="emit('rename', $event)"
        @delete="emit('delete', $event)"
        @toggle-hidden="emit('toggleHidden', $event)"
      />
    </li>
  </ul>
</template>
