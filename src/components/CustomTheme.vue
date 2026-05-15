<script setup lang="ts">
import { applyTheme, useTheme } from "../state/theme";
import { type ThemeConfig } from "../ipc";
import { Button } from "./ui";

const emit = defineEmits<{ back: [] }>();
const { theme } = useTheme();

const ansiNames = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "bright black", "bright red", "bright green", "bright yellow",
  "bright blue", "bright magenta", "bright cyan", "bright white",
];

function updateSingleField(field: "background" | "foreground" | "cursor", value: string) {
  const next: ThemeConfig = { ...theme.value, [field]: value };
  void applyTheme(next);
}

function updatePaletteIndex(idx: number, value: string) {
  const palette = [...theme.value.palette];
  palette[idx] = value;
  void applyTheme({ ...theme.value, palette });
}

const rowClass =
  "grid grid-cols-[1fr_auto_auto] items-center gap-3 px-3 py-2 rounded-md bg-surface-1 border border-border hover:border-border-strong cursor-pointer text-sm";
const valueClass = "font-mono text-[11px] text-fg-muted tracking-wider";
const colorClass =
  "w-11 h-6 appearance-none border border-border rounded p-0 bg-transparent cursor-pointer";
const swatchClass = "w-full h-8 appearance-none border border-border rounded p-0 bg-transparent cursor-pointer";
</script>

<template>
  <div class="absolute inset-0 flex flex-col gap-4 px-9 pt-8 pb-6 overflow-y-auto text-fg">
    <Button variant="ghost" @click="emit('back')">← Themes</Button>
    <h2 class="m-0 text-base font-medium tracking-wide">Custom theme</h2>
    <div class="flex flex-col gap-5 max-w-130">
      <div class="flex flex-col gap-1.5">
        <label :class="rowClass">
          <span>Background</span>
          <span :class="valueClass">{{ theme.background }}</span>
          <input
            type="color"
            :value="theme.background"
            :class="colorClass"
            @change="updateSingleField('background', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label :class="rowClass">
          <span>Foreground</span>
          <span :class="valueClass">{{ theme.foreground }}</span>
          <input
            type="color"
            :value="theme.foreground"
            :class="colorClass"
            @change="updateSingleField('foreground', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label :class="rowClass">
          <span>Cursor</span>
          <span :class="valueClass">{{ theme.cursor }}</span>
          <input
            type="color"
            :value="theme.cursor"
            :class="colorClass"
            @change="updateSingleField('cursor', ($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
      <div class="flex flex-col gap-2">
        <div class="text-[11px] text-fg-muted uppercase tracking-[0.06em]">Palette (ANSI 0–15)</div>
        <div class="grid grid-cols-8 gap-1.5">
          <input
            v-for="(c, i) in theme.palette.slice(0, 16)"
            :key="i"
            type="color"
            :class="swatchClass"
            :value="c ?? '#000000'"
            :title="`${i}: ${ansiNames[i]}`"
            @change="updatePaletteIndex(i, ($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>
    </div>
  </div>
</template>
