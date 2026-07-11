<script setup lang="ts">
import { dragGhost } from "../state/drag";
</script>

<!-- The one floating pill that follows the cursor during any drag — tab
     pills, the + button, pane titlebars, and foreign (cross-window) hovers
     all feed state/drag's `dragGhost`. Rendered once, from App.vue. -->
<template>
  <Teleport to="body">
    <div
      v-if="dragGhost"
      class="drag-ghost"
      :style="{ left: `${dragGhost.x + 12}px`, top: `${dragGhost.y + 12}px` }"
    >
      {{ dragGhost.label }}
    </div>
  </Teleport>
</template>

<style scoped>
.drag-ghost {
  position: fixed;
  z-index: 9999;
  pointer-events: none;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 9999px;
  color: var(--fg, #e6e6e6);
  background: var(--surface-3, #333);
  border: 1px solid var(--border-strong, rgba(255, 255, 255, 0.2));
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  opacity: 0.92;
}
</style>
