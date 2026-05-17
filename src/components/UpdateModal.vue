<script setup lang="ts">
import { computed } from "vue";

import {
  dismissUpdate,
  installUpdate,
  useUpdate,
} from "../state/update";
import { Button, Modal } from "./ui";

const { status, available, progress, errorMessage } = useUpdate();

// The modal is invisible while idle/checking — those states never block
// the UI; only a result (available / uptodate / error) or an in-progress
// download is worth a dialog.
const visible = computed(
  () =>
    status.value === "available" ||
    status.value === "downloading" ||
    status.value === "uptodate" ||
    status.value === "error",
);

const heading = computed(() => {
  switch (status.value) {
    case "uptodate":
      return "You're up to date";
    case "error":
      return "Update failed";
    default:
      return "Update available";
  }
});

const percent = computed(() =>
  progress.value === null ? null : Math.round(progress.value * 100),
);
</script>

<template>
  <Modal v-if="visible">
    <h2 class="m-0 text-base font-semibold text-fg">{{ heading }}</h2>

    <template v-if="status === 'uptodate'">
      <p class="m-0 text-xs text-fg-muted leading-snug">
        You're running the latest version of Prmpt.
      </p>
      <div class="flex justify-end mt-1.5">
        <Button variant="secondary" @click="dismissUpdate">Close</Button>
      </div>
    </template>

    <template v-else-if="status === 'error'">
      <p class="m-0 text-xs text-fg-muted leading-snug">
        The update could not be installed. You can keep using the current
        version and try again later.
      </p>
      <pre
        class="m-0 max-h-40 overflow-auto font-mono text-[11px] text-danger whitespace-pre-wrap break-all"
        >{{ errorMessage }}</pre
      >
      <div class="flex justify-end mt-1.5">
        <Button variant="secondary" @click="dismissUpdate">Close</Button>
      </div>
    </template>

    <template v-else>
      <p class="m-0 text-xs text-fg-muted leading-snug">
        Prmpt
        <span class="text-fg font-mono">{{ available?.version }}</span>
        is available
        <template v-if="available?.currentVersion">
          (you have
          <span class="font-mono">{{ available?.currentVersion }}</span
          >)</template
        >. The update is downloaded and verified, then Prmpt restarts.
      </p>
      <pre
        v-if="available?.body"
        class="m-0 max-h-48 overflow-auto bg-surface-2 rounded-md p-2.5 font-mono text-[11px] text-fg leading-snug whitespace-pre-wrap break-words"
        >{{ available?.body }}</pre
      >

      <div
        v-if="status === 'downloading'"
        class="flex flex-col gap-1.5"
      >
        <div class="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            class="h-full rounded-full bg-accent transition-[width] duration-150"
            :class="{ 'animate-pulse w-1/3': percent === null }"
            :style="percent !== null ? { width: percent + '%' } : undefined"
          />
        </div>
        <span class="text-[11px] text-fg-muted">
          {{ percent !== null ? `Downloading… ${percent}%` : "Downloading…" }}
        </span>
      </div>

      <div v-else class="flex gap-2 justify-end mt-1.5">
        <Button variant="secondary" @click="dismissUpdate">Later</Button>
        <Button variant="primary" @click="installUpdate">
          Install &amp; Restart
        </Button>
      </div>
    </template>
  </Modal>
</template>
