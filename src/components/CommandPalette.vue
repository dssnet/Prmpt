<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ChevronLeft, CornerDownLeft, Search } from "lucide-vue-next";

import {
  closeCommandPalette,
  collectRootCommands,
  paletteOpen,
  scoreCommand,
  SECTION_ORDER,
  type Command,
} from "../state/commandPalette";
import { focusCanvas } from "../state/terminal";
// Side-effect: registers the first-party commands on first import.
import "../state/commands";

// Raycast-style launcher. The runtime (state/commandPalette.ts) owns the open
// flag, the command sources and fuzzy scoring; this component owns the
// navigation stack (root page → sub-pages via `children`), the query, keyboard
// driving and rendering.

interface Page {
  title: string;
  placeholder: string;
  commands: Command[];
}

const pages = ref<Page[]>([]);
const query = ref("");
const selected = ref(0);
const loading = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);

const current = computed<Page | null>(() => pages.value[pages.value.length - 1] ?? null);
const placeholder = computed(() => current.value?.placeholder ?? "Search…");
const crumb = computed(() => (pages.value.length > 1 ? current.value?.title ?? "" : ""));

// Filtered + ranked commands for the active page, in display order.
const visibleItems = computed<Command[]>(() => {
  const cmds = current.value?.commands ?? [];
  const q = query.value.trim();
  const scored = cmds
    .map((cmd) => ({ cmd, score: scoreCommand(q, cmd) }))
    .filter((s) => s.score >= 0);
  if (q) {
    scored.sort(
      (a, b) => b.score - a.score || a.cmd.title.localeCompare(b.cmd.title),
    );
  }
  return scored.map((s) => s.cmd);
});

type Row =
  | { kind: "header"; label: string }
  | { kind: "item"; cmd: Command; index: number };

// Empty query → section headers in SECTION_ORDER. With a query (or a sub-page
// whose commands carry no section) → a flat ranked list, no headers.
const rows = computed<Row[]>(() => {
  const items = visibleItems.value;
  const q = query.value.trim();
  const out: Row[] = [];
  let index = 0;
  const grouped = !q && items.some((i) => i.section);
  if (!grouped) {
    for (const cmd of items) out.push({ kind: "item", cmd, index: index++ });
    return out;
  }
  const bySection = new Map<string, Command[]>();
  for (const cmd of items) {
    const s = cmd.section ?? "Other";
    (bySection.get(s) ?? bySection.set(s, []).get(s)!).push(cmd);
  }
  const rank = (s: string) => {
    const i = SECTION_ORDER.indexOf(s);
    return i < 0 ? SECTION_ORDER.length : i;
  };
  for (const sec of [...bySection.keys()].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  )) {
    out.push({ kind: "header", label: sec });
    for (const cmd of bySection.get(sec)!) {
      out.push({ kind: "item", cmd, index: index++ });
    }
  }
  return out;
});

// Items in display order (rows minus headers). Keyboard nav, Enter and the
// selection highlight all index into this — `visibleItems` is source order,
// which the grouped view reorders, so indexing it by `row.index` would
// activate a different command than the highlighted one.
const orderedItems = computed<Command[]>(() =>
  rows.value.flatMap((r) => (r.kind === "item" ? [r.cmd] : [])),
);

function focusInput(): void {
  void nextTick(() => inputEl.value?.focus());
}

function close(): void {
  closeCommandPalette();
  focusCanvas();
}

async function loadRoot(): Promise<void> {
  loading.value = true;
  try {
    const cmds = await collectRootCommands();
    pages.value = [
      { title: "", placeholder: "Type a command or search…", commands: cmds },
    ];
  } catch (err) {
    console.error("command palette load failed:", err);
    pages.value = [{ title: "", placeholder: "Search…", commands: [] }];
  } finally {
    loading.value = false;
  }
  query.value = "";
  selected.value = 0;
  focusInput();
}

/** Push a command's sub-page. Returns once it's loaded (or on failure). */
async function descend(cmd: Command): Promise<void> {
  if (!cmd.children) return;
  loading.value = true;
  try {
    const kids = await cmd.children();
    pages.value.push({
      title: cmd.title,
      placeholder: cmd.childPlaceholder ?? "Search…",
      commands: kids,
    });
    query.value = "";
    selected.value = 0;
  } catch (err) {
    console.error("command children failed:", err);
  } finally {
    loading.value = false;
  }
  focusInput();
}

/** Pop one sub-page. Returns false when already at the root. */
function ascend(): boolean {
  if (pages.value.length <= 1) return false;
  pages.value.pop();
  query.value = "";
  selected.value = 0;
  focusInput();
  return true;
}

async function activate(cmd: Command): Promise<void> {
  if (cmd.children) {
    await descend(cmd);
    return;
  }
  const keepOpen = await cmd.perform?.();
  if (keepOpen === false) {
    focusInput();
    return;
  }
  close();
}

function move(delta: number): void {
  const n = orderedItems.value.length;
  if (n === 0) return;
  selected.value = (selected.value + delta + n) % n;
}

// Hover only moves the selection when the pointer physically moved. Scrolling
// (keyboard scrollIntoView) slides rows under a stationary cursor, and the
// engine re-evaluates hover with a synthetic mousemove — without this guard
// that snaps the selection back to the row under the mouse on every ArrowDown.
let pointerX = -1;
let pointerY = -1;
function onRowHover(e: MouseEvent, index: number): void {
  if (e.clientX === pointerX && e.clientY === pointerY) return;
  pointerX = e.clientX;
  pointerY = e.clientY;
  selected.value = index;
}

function onKeydown(e: KeyboardEvent): void {
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      move(1);
      break;
    case "ArrowUp":
      e.preventDefault();
      move(-1);
      break;
    case "Enter": {
      e.preventDefault();
      const cmd = orderedItems.value[selected.value];
      if (cmd) void activate(cmd);
      break;
    }
    case "Escape":
      e.preventDefault();
      if (!ascend()) close();
      break;
    case "Backspace":
      // Empty field + sub-page → step back up a level (like a path).
      if (query.value === "" && pages.value.length > 1) {
        e.preventDefault();
        ascend();
      }
      break;
    case "k":
    case "K":
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        // Stop the bubble to App's window handler: it would otherwise see
        // `paletteOpen` already flipped false and re-fire the open shortcut.
        e.stopPropagation();
        close();
      }
      break;
  }
}

// Reset/clamp selection when the visible set changes (typing, page nav).
watch(orderedItems, () => {
  if (selected.value >= orderedItems.value.length) selected.value = 0;
});

// Keep the highlighted row in view. When the row sits directly under a section
// header (first item of its section), pull the header in too so arrowing up
// doesn't leave it hidden just above the fold.
watch(selected, () =>
  nextTick(() => {
    const el = listEl.value?.querySelector<HTMLElement>(
      `[data-idx="${selected.value}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    const prev = el.previousElementSibling;
    if (prev && !prev.hasAttribute("data-idx")) {
      prev.scrollIntoView({ block: "nearest" });
    }
  }),
);

watch(paletteOpen, (open) => {
  if (open) void loadRoot();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="paletteOpen"
      class="fixed inset-0 z-[1000] flex justify-center px-4 pt-[12vh] backdrop-blur-sm"
      style="background: color-mix(in srgb, var(--bg) 55%, transparent)"
      @pointerdown.self="close"
    >
      <div
        class="flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border-strong bg-surface-1 shadow-[0_24px_60px_rgba(0,0,0,0.55)]"
        @pointerdown.stop
      >
        <!-- search row -->
        <div class="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
          <button
            v-if="pages.length > 1"
            type="button"
            class="flex items-center rounded-md p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
            title="Back"
            @click="ascend"
          >
            <ChevronLeft :size="16" />
          </button>
          <Search v-else :size="16" class="shrink-0 text-fg-subtle" />
          <span
            v-if="crumb"
            class="shrink-0 rounded-md bg-surface-2 px-2 py-0.5 text-xs font-medium text-fg-muted"
          >{{ crumb }}</span>
          <input
            ref="inputEl"
            v-model="query"
            type="text"
            class="min-w-0 flex-1 border-0 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
            :placeholder="placeholder"
            spellcheck="false"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            @keydown="onKeydown"
          />
        </div>

        <!-- results -->
        <div ref="listEl" class="min-h-0 flex-1 overflow-y-auto p-1.5">
          <template v-if="rows.length">
            <template v-for="(row, ri) in rows" :key="ri">
              <div
                v-if="row.kind === 'header'"
                class="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase select-none"
              >
                {{ row.label }}
              </div>
              <button
                v-else
                type="button"
                :data-idx="row.index"
                class="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left"
                :class="
                  row.index === selected
                    ? 'bg-accent/22 text-fg'
                    : 'text-fg-muted'
                "
                @mousemove="onRowHover($event, row.index)"
                @click="activate(row.cmd)"
              >
                <component
                  :is="row.cmd.icon"
                  v-if="row.cmd.icon"
                  :size="16"
                  class="shrink-0"
                  :class="row.cmd.danger ? 'text-danger' : 'text-fg-subtle'"
                />
                <span class="flex min-w-0 flex-1 flex-col">
                  <span
                    class="truncate text-sm"
                    :class="row.cmd.danger ? 'text-danger' : ''"
                  >{{ row.cmd.title }}</span>
                  <span
                    v-if="row.cmd.subtitle"
                    class="truncate text-xs text-fg-subtle"
                  >{{ row.cmd.subtitle }}</span>
                </span>
                <span v-if="row.cmd.children" class="shrink-0 text-fg-subtle">›</span>
                <span
                  v-else-if="row.cmd.shortcut"
                  class="flex shrink-0 items-center gap-1"
                >
                  <kbd
                    v-for="(k, ki) in row.cmd.shortcut"
                    :key="ki"
                    class="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] leading-none text-fg-subtle"
                  >{{ k }}</kbd>
                </span>
              </button>
            </template>
          </template>
          <div
            v-else
            class="px-3 py-8 text-center text-sm text-fg-subtle select-none"
          >
            {{ loading ? "Loading…" : "No matching commands" }}
          </div>
        </div>

        <!-- footer hints -->
        <div
          class="flex items-center gap-3 border-t border-border px-3.5 py-1.5 text-[11px] text-fg-subtle select-none"
        >
          <span class="flex items-center gap-1"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span class="flex items-center gap-1"><CornerDownLeft :size="11" /> select</span>
          <span class="flex items-center gap-1"><kbd>esc</kbd> {{ pages.length > 1 ? "back" : "close" }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>
