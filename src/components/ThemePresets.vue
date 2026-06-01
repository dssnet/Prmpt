<script setup lang="ts">
import { Palette } from "lucide-vue-next";
import { computed, ref } from "vue";

import { getVersion } from "@tauri-apps/api/app";

import { applyTheme, useTheme } from "../state/theme";
import { findPresetMatch, PRESETS } from "../state/themes";
import { runUpdateCheck, useUpdate } from "../state/update";
import { Button } from "./ui";

const emit = defineEmits<{ back: []; openCustom: [] }>();
const { theme } = useTheme();
const { status: updateStatus } = useUpdate();

const activeName = computed(() => findPresetMatch(theme.value));

const version = ref<string>("");
void getVersion().then((v) => {
  version.value = v;
});

async function pickPreset(idx: number) {
  await applyTheme(PRESETS[idx].theme);
}

const cardClass =
  "flex flex-col gap-2 p-3 rounded-lg bg-surface-1 border border-border text-fg-muted text-left cursor-pointer font-[inherit] hover:bg-surface-2 hover:border-border-strong active:translate-y-px transition-colors duration-150";

function classFor(active: boolean): string {
  return active
    ? `${cardClass} !border-accent shadow-[inset_0_0_0_1px_var(--color-accent)]`
    : cardClass;
}
</script>

<template>
  <div class="absolute inset-0 flex flex-col gap-4 px-9 pt-2 pb-6 overflow-y-auto text-fg">
    <Button variant="ghost" @click="emit('back')">← Back</Button>
    <h2 class="m-0 text-base font-medium tracking-wide text-fg">Theme</h2>
    <div class="grid gap-3 grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
      <button
        v-for="(preset, i) in PRESETS"
        :key="preset.name"
        type="button"
        :class="classFor(activeName === preset.name)"
        @click="pickPreset(i)"
      >
        <div
          class="w-full h-14 rounded-md flex items-center justify-center font-mono text-[22px] font-medium"
          :style="{ background: preset.theme.background, color: preset.theme.foreground }"
        >
          Aa
        </div>
        <div class="flex gap-0.75">
          <span
            v-for="(c, j) in preset.theme.palette.slice(0, 8)"
            :key="j"
            class="flex-1 h-2.5 rounded-xs"
            :style="{ background: c }"
          />
        </div>
        <div class="text-xs text-fg">{{ preset.name }}</div>
      </button>
      <button
        type="button"
        :class="classFor(activeName === null)"
        @click="emit('openCustom')"
      >
        <div class="w-full h-14 rounded-md flex items-center justify-center bg-transparent text-fg border border-dashed border-border-strong">
          <Palette :size="28" :stroke-width="1.8" />
        </div>
        <div class="flex gap-0.75">
          <span
            v-for="(c, j) in theme.palette.slice(0, 8)"
            :key="j"
            class="flex-1 h-2.5 rounded-xs"
            :style="{ background: c }"
          />
        </div>
        <div class="text-xs text-fg">Custom</div>
      </button>
    </div>

    <h2 class="m-0 mt-2 text-base font-medium tracking-wide text-fg">Updates</h2>
    <div class="flex items-center gap-3">
      <Button
        variant="secondary"
        :disabled="updateStatus === 'checking' || updateStatus === 'downloading'"
        @click="runUpdateCheck(true)"
      >
        {{ updateStatus === "checking" ? "Checking…" : "Check for updates" }}
      </Button>
      <span v-if="version" class="text-xs text-fg-muted">
        Current version {{ version }}
      </span>
    </div>
  </div>
</template>
