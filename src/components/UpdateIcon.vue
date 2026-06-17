<script setup lang="ts">
/**
 * Tab-bar update indicator: a green download icon that only appears once
 * a background check has found a newer release (update status
 * "available"). Clicking it opens the update dialog (UpdateModal). It
 * sits next to the notification center in TabBar.
 */
import { computed } from "vue";
import { Download } from "lucide-vue-next";

import { openUpdateModal, useUpdate } from "../state/update";

const { status, available } = useUpdate();

const show = computed(() => status.value === "available");

const title = computed(() =>
  available.value
    ? `Prmpt ${available.value.version} available — click to update`
    : "Update available",
);
</script>

<template>
  <button
    v-if="show"
    type="button"
    :title="title"
    class="update-icon relative flex-none flex items-center justify-center w-6 h-6 rounded-full cursor-pointer transition-colors duration-100"
    @click="openUpdateModal"
  >
    <Download :size="13" />
  </button>
</template>

<style scoped>
.update-icon {
  color: var(--update-green, #a6e3a1);
  background: color-mix(in srgb, var(--update-green, #a6e3a1) 16%, transparent);
}
.update-icon:hover {
  background: color-mix(in srgb, var(--update-green, #a6e3a1) 28%, transparent);
}
</style>
