<script setup lang="ts">
import { X } from "lucide-vue-next";

import { dismissToast, toasts } from "../state/toasts";
</script>

<template>
  <Teleport to="body">
    <TransitionGroup name="toast" tag="div" class="toast-stack">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        :class="{ 'toast-error': t.kind === 'error' }"
      >
        <div class="toast-head">
          <span class="toast-host" :title="t.host">{{ t.host }}</span>
          <span class="toast-title">{{ t.title }}</span>
          <button type="button" class="toast-x" title="Dismiss" @click="dismissToast(t.id)">
            <X :size="11" />
          </button>
        </div>
        <div class="toast-detail" :title="t.detail">{{ t.detail }}</div>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  pointer-events: none;
}
.toast {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 260px;
  padding: 7px 8px 7px 10px;
  font-size: 12px;
  border-radius: 8px;
  color: var(--fg-muted, #cdd6f4);
  background: var(--surface-3, #313244);
  border: 1px solid var(--border-strong, rgba(255, 255, 255, 0.18));
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
  pointer-events: auto;
}
.toast-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.toast-host {
  flex: none;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 7px;
  font-size: 10px;
  border-radius: 9999px;
  color: var(--accent, #89b4fa);
  background: color-mix(in srgb, var(--accent, #89b4fa) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent, #89b4fa) 35%, transparent);
}
.toast-error .toast-host {
  color: var(--danger, #f38ba8);
  background: color-mix(in srgb, var(--danger, #f38ba8) 14%, transparent);
  border-color: color-mix(in srgb, var(--danger, #f38ba8) 35%, transparent);
}
.toast-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--fg, #e6e6e6);
}
.toast-error .toast-title {
  color: var(--danger, #f38ba8);
}
.toast-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-subtle, #9399b2);
}
.toast-x {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 9999px;
  color: var(--fg-subtle, #9399b2);
  cursor: pointer;
}
.toast-x:hover {
  color: var(--fg, #e6e6e6);
  background: color-mix(in srgb, var(--fg, #fff) 14%, transparent);
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 150ms ease, transform 150ms ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active {
    transition: none;
  }
}
</style>
