<script setup lang="ts">
import type { PaneId } from "../state/ids";
import { useTerminalScroll } from "../composables/useTerminalScroll";
import { Scrollbar } from "./ui";

const props = defineProps<{
  tabId: PaneId;
  rect?: { x: number; y: number; w: number; h: number };
}>();

const { position, range, viewportSize, onScrollTo, onPageBy } =
  useTerminalScroll(props.tabId);
</script>

<template>
  <Scrollbar
    :position="position"
    :range="range"
    :viewport-size="viewportSize"
    :rect="rect"
    @scroll-to="onScrollTo"
    @page-by="onPageBy"
  />
</template>
