<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Plus, X } from "lucide-vue-next";

// Chip editor for a CSS font-family stack. The string model stays the
// config.toml value ("\"Noto Nerd Font Mono\", Menlo, monospace"); this
// component renders each family as a removable bubble (order = priority,
// first wins) and offers a dropdown of detected/suggested fonts plus
// free-text entry for anything else.
const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

// Focus the dropdown's filter input when it opens.
const vFocus = { mounted: (el: HTMLInputElement) => el.focus() };

// CSS generic families — always valid, never quoted.
const GENERICS = new Set(["monospace", "ui-monospace", "system-ui"]);

// Common monospace families worth offering; filtered to the ones the
// engine can actually resolve (plus the bundled Nerd Font and generics).
const SUGGESTED = [
  "Noto Nerd Font Mono",
  "Menlo",
  "Monaco",
  "SF Mono",
  "Consolas",
  "Cascadia Code",
  "Cascadia Mono",
  "JetBrains Mono",
  "Fira Code",
  "Hack",
  "Source Code Pro",
  "IBM Plex Mono",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Noto Color Emoji",
  "Courier New",
  "ui-monospace",
  "monospace",
];
// Bundled / generic entries that are available regardless of what
// document.fonts.check can detect on this machine.
const ALWAYS = new Set(["Noto Nerd Font Mono", ...GENERICS]);

function parseStack(stack: string): string[] {
  return stack
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
}
function quoteIfNeeded(name: string): string {
  if (GENERICS.has(name)) return name;
  return /^[A-Za-z][A-Za-z0-9-]*$/.test(name) ? name : `"${name}"`;
}
function serialize(fonts: string[]): string {
  return fonts.map(quoteIfNeeded).join(", ");
}

const fonts = computed(() => parseStack(props.modelValue));

function removeFont(i: number): void {
  const next = fonts.value.slice();
  next.splice(i, 1);
  emit("update:modelValue", serialize(next));
}

function addFont(name: string): void {
  const n = name.trim().replace(/^["']|["']$/g, "").trim();
  if (!n) return;
  if (!fonts.value.some((f) => f.toLowerCase() === n.toLowerCase())) {
    emit("update:modelValue", serialize([...fonts.value, n]));
  }
  query.value = "";
  open.value = false;
}

// ---- dropdown ----
const open = ref(false);
const query = ref("");
const rootEl = ref<HTMLElement | null>(null);
const available = ref<Set<string>>(new Set(ALWAYS));

onMounted(() => {
  // Best-effort installed-font detection; anything missed can still be typed.
  const found = new Set(ALWAYS);
  for (const f of SUGGESTED) {
    try {
      if (document.fonts.check(`12px "${f}"`)) found.add(f);
    } catch {
      /* ignore — detection is a hint, not a gate */
    }
  }
  available.value = found;
  document.addEventListener("mousedown", onDocDown);
});
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocDown));

function onDocDown(e: MouseEvent): void {
  if (!rootEl.value?.contains(e.target as Node)) open.value = false;
}

const suggestions = computed(() => {
  const q = query.value.trim().toLowerCase();
  const inStack = new Set(fonts.value.map((f) => f.toLowerCase()));
  return SUGGESTED.filter(
    (f) =>
      available.value.has(f) &&
      !inStack.has(f.toLowerCase()) &&
      (!q || f.toLowerCase().includes(q)),
  );
});

function submitQuery(): void {
  if (query.value.trim()) addFont(query.value);
}
</script>

<template>
  <div ref="rootEl" class="relative min-w-0">
    <div
      class="flex flex-wrap items-center gap-1.5 px-2 py-1.5 min-h-[34px] rounded-md bg-surface-1 border border-border"
    >
      <span
        v-for="(f, i) in fonts"
        :key="f"
        class="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-[11px] bg-surface-2 border border-border text-fg-muted"
        :title="i === 0 ? `${f} — primary font` : f"
      >
        <span class="truncate max-w-40">{{ f }}</span>
        <button
          type="button"
          class="grid place-items-center w-3.5 h-3.5 rounded-full text-fg-subtle hover:text-fg hover:bg-surface-3 cursor-pointer"
          :title="`Remove ${f}`"
          @click="removeFont(i)"
        >
          <X :size="9" :stroke-width="2.5" />
        </button>
      </span>
      <button
        type="button"
        class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[11px] text-fg-subtle border border-dashed border-border-strong hover:text-fg hover:bg-surface-2 cursor-pointer"
        @click="open = !open"
      >
        <Plus :size="11" /> Add
      </button>
    </div>

    <Transition name="pop">
    <div
      v-if="open"
      class="pop-panel origin-top-right absolute right-0 top-full mt-1 w-60 z-50 p-1.5 flex flex-col gap-1"
    >
      <input
        v-model="query"
        v-focus
        placeholder="Type a font name…"
        spellcheck="false"
        class="w-full bg-surface-2 border border-border text-fg rounded-md px-2 py-1 text-xs focus:outline-none focus:border-border-strong"
        @keydown.enter.prevent="submitQuery"
        @keydown.esc="open = false"
      />
      <div class="max-h-44 overflow-y-auto flex flex-col gap-px">
        <button
          v-for="f in suggestions"
          :key="f"
          type="button"
          class="px-2 py-1 rounded-md text-left text-xs text-fg-muted hover:bg-surface-2 hover:text-fg cursor-pointer"
          :style="{ fontFamily: quoteIfNeeded(f) }"
          @mousedown.prevent="addFont(f)"
        >
          {{ f }}
        </button>
        <div
          v-if="suggestions.length === 0"
          class="px-2 py-1.5 text-[11px] text-fg-subtle leading-snug"
        >
          {{ query.trim() ? `Press Enter to add “${query.trim()}”.` : "No more suggestions — type a name and press Enter." }}
        </div>
      </div>
    </div>
    </Transition>
  </div>
</template>
