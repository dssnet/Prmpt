<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  GitBranch as GitBranchIcon,
  History,
  Minus,
  Plus,
  RefreshCw,
  X,
} from "lucide-vue-next";

import {
  gitBranches,
  gitCommitChanges,
  gitCreateBranch,
  gitDiffFile,
  gitLog,
  gitStage,
  gitStatus,
  gitSwitchBranch,
  gitUnstage,
  localHomeDir,
  type GitBranch,
  type GitCommit,
  type GitFileEntry,
  type GitStatusSnapshot,
} from "../ipc";
import { getGitPanelState } from "../state/gitPanel";
import { Button, DropdownMenu, EmptyState, ErrorMessage, Input, Textarea } from "./ui";

const props = withDefaults(
  defineProps<{
    canClose?: boolean;
    /** Panel pane id — keys this panel's commit-draft / log state so it
     *  survives tab-switch unmounts and stays distinct per panel. */
    paneId?: number | null;
    /** Initial folder to inspect (the repo enclosing it). Seeded from the
     *  terminal pill; the in-panel folder picker takes over after that. */
    seedPath?: string | null;
  }>(),
  { canClose: true, paneId: null, seedPath: null },
);
const emit = defineEmits<{ close: [] }>();

// Focus a freshly-mounted inline input (same directive as the browsers).
const vFocus = {
  mounted: (el: HTMLElement) =>
    (el instanceof HTMLInputElement ? el : el.querySelector("input"))?.focus(),
};

// Per-pane commit draft + log-expanded (see state/gitPanel.ts).
const gitState = computed(() => getGitPanelState(`pane:${props.paneId ?? "_"}`));
const commitDraft = computed({
  get: () => gitState.value.commitDraft.value,
  set: (v) => {
    gitState.value.commitDraft.value = v;
  },
});
const logExpanded = computed({
  get: () => gitState.value.logExpanded.value,
  set: (v) => {
    gitState.value.logExpanded.value = v;
  },
});

// ---- target folder ----
// The panel shows whatever repo encloses `dir` (the backend walks up). `dir`
// is chosen explicitly: seeded once on mount (from the terminal pill, else
// the home directory) and changed only via the in-panel folder picker.
const dir = ref<string | null>(null);

async function initDir(): Promise<void> {
  dir.value = props.seedPath || (await localHomeDir().catch(() => null));
}

/** Open a native folder chooser and inspect the picked directory. */
async function pickFolder(): Promise<void> {
  const picked = await openDialog({
    directory: true,
    defaultPath: dir.value ?? undefined,
  }).catch(() => null);
  const next = Array.isArray(picked) ? picked[0] : picked;
  if (!next) return;
  dir.value = next;
  await refreshAll();
}

// ---- status state ----
type PanelState = "loading" | "git_missing" | "not_a_repo" | "repo";
const state = ref<PanelState>("loading");
const repo = ref<GitStatusSnapshot | null>(null);
const branches = ref<GitBranch[]>([]);
const log = ref<GitCommit[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

async function refreshAll(): Promise<void> {
  const d = dir.value;
  if (!d) return;
  loading.value = true;
  try {
    const status = await gitStatus(d);
    if (status.kind !== "repo") {
      state.value = status.kind;
      repo.value = null;
      branches.value = [];
      log.value = [];
      return;
    }
    // Repo changed underneath the panel: stale diff/error would be misleading.
    if (repo.value && repo.value.root !== status.root) {
      diffSel.value = null;
      error.value = null;
    }
    repo.value = status;
    state.value = "repo";
    const [br, lg] = await Promise.all([
      gitBranches(status.root).catch(() => [] as GitBranch[]),
      gitLog(status.root, 50).catch(() => [] as GitCommit[]),
    ]);
    branches.value = br;
    log.value = lg;
    if (diffSel.value) await loadDiff();
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function syncAndRefresh(): Promise<void> {
  if (!dir.value) await initDir();
  await refreshAll();
}

// Commits / branch changes made in a terminal only become visible on some
// signal; window refocus is the cheapest full one (re-stats the current dir).
function onWindowFocus(): void {
  void refreshAll();
}

onMounted(() => {
  void syncAndRefresh();
  window.addEventListener("focus", onWindowFocus);
});
onBeforeUnmount(() => {
  window.removeEventListener("focus", onWindowFocus);
});

// ---- mutations ----
async function mutate(op: () => Promise<unknown>): Promise<void> {
  error.value = null;
  try {
    await op();
  } catch (e) {
    error.value = String(e);
  }
  await refreshAll();
}

const root = computed(() => repo.value?.root ?? "");

function stagePaths(paths: string[]): void {
  void mutate(() => gitStage(root.value, paths));
}
function unstagePaths(paths: string[]): void {
  void mutate(() => gitUnstage(root.value, paths));
}

const canCommit = computed(
  () =>
    state.value === "repo" &&
    (repo.value?.staged.length ?? 0) > 0 &&
    commitDraft.value.trim().length > 0,
);
async function doCommit(): Promise<void> {
  if (!canCommit.value) return;
  const msg = commitDraft.value;
  error.value = null;
  try {
    await gitCommitChanges(root.value, msg);
    commitDraft.value = "";
  } catch (e) {
    error.value = String(e);
  }
  await refreshAll();
}

// ---- branches ----
const branchOptions = computed(() =>
  branches.value.map((b) => ({ value: b.name, label: b.name })),
);
const currentBranch = computed(
  () =>
    repo.value?.branch ??
    branches.value.find((b) => b.current)?.name ??
    "",
);
const branchLabel = computed(() => {
  if (repo.value?.branch) return repo.value.branch;
  if (repo.value?.detached_at) return `detached @ ${repo.value.detached_at}`;
  return "(no branch)";
});
function onPickBranch(name: string): void {
  if (name === currentBranch.value) return;
  void mutate(() => gitSwitchBranch(root.value, name));
}

const newBranchOpen = ref(false);
const newBranchName = ref("");
function submitNewBranch(): void {
  const name = newBranchName.value.trim();
  newBranchOpen.value = false;
  newBranchName.value = "";
  if (!name) return;
  void mutate(() => gitCreateBranch(root.value, name));
}

// ---- diff drill-in ----
const diffSel = ref<{ entry: GitFileEntry; staged: boolean } | null>(null);
const diffText = ref("");
const diffLoading = ref(false);

async function loadDiff(): Promise<void> {
  const sel = diffSel.value;
  if (!sel) return;
  diffLoading.value = true;
  try {
    diffText.value = await gitDiffFile(
      root.value,
      sel.entry.path,
      sel.staged,
      sel.entry.status === "untracked",
    );
  } catch (e) {
    diffText.value = String(e);
  } finally {
    diffLoading.value = false;
  }
}
function openDiff(entry: GitFileEntry, staged: boolean): void {
  diffSel.value = { entry, staged };
  diffText.value = "";
  void loadDiff();
}

type DiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx";
const diffLines = computed<{ text: string; kind: DiffLineKind }[]>(() =>
  diffText.value.split("\n").map((text) => {
    let kind: DiffLineKind = "ctx";
    if (text.startsWith("@@")) kind = "hunk";
    else if (text.startsWith("+++") || text.startsWith("---")) kind = "meta";
    else if (text.startsWith("+")) kind = "add";
    else if (text.startsWith("-")) kind = "del";
    else if (/^(diff |index |old mode|new mode|new file|deleted file|similarity|rename |copy |Binary files|\\ No newline)/.test(text))
      kind = "meta";
    return { text, kind };
  }),
);

// ---- presentation helpers ----
const STATUS_LETTER: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  untracked: "U",
  conflicted: "!",
};
function statusLetter(s: string): string {
  return STATUS_LETTER[s] ?? "?";
}
function statusClass(s: string): string {
  switch (s) {
    case "added":
    case "untracked":
      return "st-add";
    case "deleted":
    case "conflicted":
      return "st-del";
    case "renamed":
    case "copied":
      return "st-ren";
    default:
      return "st-mod";
  }
}

/** "now", "5m", "3h", "2d", "4w", "8mo", "2y" — compact like the tab bar. */
function relTime(epochSecs: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epochSecs);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 9) return `${w}w`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}
</script>

<template>
  <aside class="flex flex-col h-full min-h-0 min-w-0 bg-surface-1 text-fg border-l border-border">
    <!-- header: branch switcher + actions -->
    <header class="flex items-center gap-1 px-2 h-8 border-b border-border shrink-0">
      <GitBranchIcon :size="14" class="text-fg-subtle shrink-0" />
      <DropdownMenu
        v-if="state === 'repo' && branchOptions.length"
        size="sm"
        class="min-w-0"
        title="Switch branch"
        :options="branchOptions"
        :model-value="currentBranch"
        :placeholder="branchLabel"
        @update:model-value="onPickBranch(String($event))"
      />
      <span
        v-else
        class="flex-1 min-w-0 truncate text-xs font-semibold text-fg-subtle"
      >
        {{ state === "repo" ? branchLabel : "Git" }}
      </span>
      <span
        v-if="repo && repo.upstream && (repo.ahead > 0 || repo.behind > 0)"
        class="shrink-0 text-[10px] text-fg-subtle tabular-nums"
        :title="`vs ${repo.upstream}`"
      >
        <template v-if="repo.ahead > 0">↑{{ repo.ahead }}</template>
        <template v-if="repo.behind > 0"> ↓{{ repo.behind }}</template>
      </span>
      <button
        v-if="state === 'repo' && !newBranchOpen"
        type="button"
        class="icon-btn"
        title="Create branch"
        @click="newBranchOpen = true"
      >
        <Plus :size="14" />
      </button>
      <button
        type="button"
        class="icon-btn"
        title="Choose folder"
        @click="pickFolder"
      >
        <FolderOpen :size="14" />
      </button>
      <button
        type="button"
        class="icon-btn"
        title="Refresh"
        @click="refreshAll"
      >
        <RefreshCw :size="14" :class="{ 'animate-spin': loading }" />
      </button>
      <button
        v-if="canClose"
        type="button"
        class="icon-btn"
        title="Hide git panel"
        @click="emit('close')"
      >
        <X :size="14" />
      </button>
    </header>

    <!-- inline new-branch field -->
    <div
      v-if="newBranchOpen"
      class="flex items-center gap-1 px-2 py-1.5 border-b border-border shrink-0"
    >
      <Input
        v-model="newBranchName"
        v-focus
        size="sm"
        placeholder="New branch name"
        :spellcheck="false"
        class="flex-1 min-w-0"
        @keydown.enter="submitNewBranch"
        @keydown.esc="
          newBranchOpen = false;
          newBranchName = '';
        "
      />
      <Button size="sm" variant="secondary" @click="submitNewBranch">
        Create
      </Button>
    </div>

    <!-- non-repo empty states -->
    <div v-if="state !== 'repo'" class="flex-1 min-h-0 p-3">
      <EmptyState v-if="state === 'git_missing'">
        git was not found on PATH.
      </EmptyState>
      <EmptyState v-else-if="state === 'not_a_repo'">
        Not a git repository
        <div
          v-if="dir"
          class="mt-1 font-mono text-xs text-fg-subtle break-all"
        >
          {{ dir }}
        </div>
        <div class="mt-2 text-xs">
          Use the folder button above to choose a git repository.
        </div>
      </EmptyState>
      <EmptyState v-else>Loading…</EmptyState>
    </div>

    <!-- diff drill-in replaces the changes list -->
    <template v-else-if="diffSel">
      <div class="flex items-center gap-1 px-2 h-7 border-b border-border shrink-0">
        <button
          type="button"
          class="icon-btn"
          title="Back to changes"
          @click="diffSel = null"
        >
          <ChevronLeft :size="14" />
        </button>
        <span class="flex-1 min-w-0 truncate text-xs font-mono" :title="diffSel.entry.path">
          {{ diffSel.entry.path }}
        </span>
        <span class="shrink-0 text-[10px] text-fg-subtle">
          {{ diffSel.staged ? "staged" : "working tree" }}
        </span>
      </div>
      <div class="flex-1 min-h-0 overflow-auto">
        <div v-if="diffLoading" class="p-3 text-xs text-fg-subtle">Loading…</div>
        <pre v-else class="diff-pre"><span
          v-for="(line, i) in diffLines"
          :key="i"
          class="diff-line"
          :class="`diff-${line.kind}`"
        >{{ line.text }}
</span></pre>
      </div>
    </template>

    <!-- changes + commit + log -->
    <template v-else>
      <div class="flex-1 min-h-0 overflow-y-auto">
        <template v-if="repo && repo.staged.length">
          <div class="section-hdr">
            <span class="flex-1">Staged Changes ({{ repo.staged.length }})</span>
            <button
              type="button"
              class="icon-btn"
              title="Unstage all"
              @click="unstagePaths(repo.staged.map((e) => e.path))"
            >
              <Minus :size="13" />
            </button>
          </div>
          <div
            v-for="e in repo.staged"
            :key="`s:${e.path}`"
            class="file-row group"
            :title="e.orig_path ? `${e.orig_path} → ${e.path}` : e.path"
            @click="openDiff(e, true)"
          >
            <span class="st-letter" :class="statusClass(e.status)">
              {{ statusLetter(e.status) }}
            </span>
            <span class="flex-1 min-w-0 truncate font-mono">{{ e.path }}</span>
            <button
              type="button"
              class="icon-btn row-btn"
              title="Unstage"
              @click.stop="unstagePaths([e.path])"
            >
              <Minus :size="13" />
            </button>
          </div>
        </template>

        <template v-if="repo && repo.unstaged.length">
          <div class="section-hdr">
            <span class="flex-1">Changes ({{ repo.unstaged.length }})</span>
            <button
              type="button"
              class="icon-btn"
              title="Stage all"
              @click="stagePaths(repo.unstaged.map((e) => e.path))"
            >
              <Plus :size="13" />
            </button>
          </div>
          <div
            v-for="e in repo.unstaged"
            :key="`u:${e.path}`"
            class="file-row group"
            :title="e.orig_path ? `${e.orig_path} → ${e.path}` : e.path"
            @click="openDiff(e, false)"
          >
            <span class="st-letter" :class="statusClass(e.status)">
              {{ statusLetter(e.status) }}
            </span>
            <span class="flex-1 min-w-0 truncate font-mono">{{ e.path }}</span>
            <button
              type="button"
              class="icon-btn row-btn"
              title="Stage"
              @click.stop="stagePaths([e.path])"
            >
              <Plus :size="13" />
            </button>
          </div>
        </template>

        <div
          v-if="repo && !repo.staged.length && !repo.unstaged.length"
          class="px-3 py-6 text-center text-xs text-fg-subtle"
        >
          No changes
        </div>
      </div>

      <!-- commit box -->
      <div class="px-2 py-2 border-t border-border shrink-0 flex flex-col gap-1.5">
        <ErrorMessage v-if="error">{{ error }}</ErrorMessage>
        <Textarea
          v-model="commitDraft"
          rows="2"
          :placeholder="`Commit message${repo?.branch ? ` (${repo.branch})` : ''}`"
        />
        <Button :disabled="!canCommit" @click="doCommit">Commit</Button>
      </div>

      <!-- history -->
      <div class="border-t border-border shrink-0 flex flex-col min-h-0" :class="{ 'log-open': logExpanded }">
        <button
          type="button"
          class="flex items-center gap-1.5 px-2 h-7 text-xs text-fg-subtle hover:text-fg cursor-pointer shrink-0"
          @click="logExpanded = !logExpanded"
        >
          <ChevronRight
            :size="12"
            class="transition-transform"
            :class="{ 'rotate-90': logExpanded }"
          />
          <History :size="12" />
          <span>History</span>
        </button>
        <div v-if="logExpanded" class="log-list overflow-y-auto">
          <div
            v-if="!log.length"
            class="px-3 py-3 text-center text-xs text-fg-subtle"
          >
            No commits yet
          </div>
          <div
            v-for="c in log"
            :key="c.hash"
            class="px-2 py-1 flex items-baseline gap-2 text-xs"
            :title="`${c.hash.slice(0, 10)} — ${c.author}`"
          >
            <span class="flex-1 min-w-0 truncate">{{ c.subject }}</span>
            <span class="shrink-0 text-[10px] text-fg-subtle">
              {{ c.author.split(" ")[0] }} · {{ relTime(c.time) }}
            </span>
          </div>
        </div>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.icon-btn {
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
.icon-btn:hover:not(:disabled) {
  color: var(--fg, #e6e6e6);
  background: color-mix(in srgb, var(--fg, #fff) 12%, transparent);
}
.icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.section-hdr {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--fg-subtle);
  position: sticky;
  top: 0;
  background: var(--surface-1);
  z-index: 1;
}
.section-hdr .icon-btn,
.file-row .icon-btn {
  width: 20px;
  height: 20px;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 4px 1px 8px;
  font-size: 12px;
  cursor: pointer;
}
.file-row:hover {
  background: color-mix(in srgb, var(--fg) 7%, transparent);
}
.row-btn {
  visibility: hidden;
}
.file-row:hover .row-btn {
  visibility: visible;
}

.st-letter {
  flex: none;
  width: 12px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
}
/* Fixed hues like --color-danger (themes only re-derive surfaces from
   bg/fg/accent, never these). */
.st-add {
  color: #a6e3a1;
}
.st-mod {
  color: #f9e2af;
}
.st-del {
  color: var(--color-danger);
}
.st-ren {
  color: var(--accent);
}

.diff-pre {
  margin: 0;
  padding: 6px 0;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
}
.diff-line {
  display: block;
  padding: 0 8px;
  white-space: pre;
}
.diff-add {
  color: #a6e3a1;
  background: color-mix(in srgb, #a6e3a1 8%, transparent);
}
.diff-del {
  color: var(--color-danger);
  background: color-mix(in srgb, var(--color-danger) 8%, transparent);
}
.diff-hunk {
  color: var(--accent);
}
.diff-meta {
  color: var(--fg-subtle);
}

.log-open {
  flex: 0 1 auto;
}
.log-list {
  max-height: 180px;
}
</style>
