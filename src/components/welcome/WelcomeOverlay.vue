<script setup lang="ts">
import { ref } from "vue";

import { fullDiskAccessGranted } from "../../ipc";
import { Button } from "../ui";
import HelloAnimation from "./HelloAnimation.vue";
import StepFda from "./StepFda.vue";
import StepImport from "./StepImport.vue";

const emit = defineEmits<{ close: [] }>();

const step = ref<"hello" | "fda" | "import">("hello");
const helloDone = ref(false);

// Kick the probe off immediately so "Get started" can branch without a
// visible wait. A failed check is treated as granted — same tolerance as
// the old first-run modal: never nag when we can't tell.
const fdaCheck: Promise<boolean> = fullDiskAccessGranted().catch(() => true);

async function next(): Promise<void> {
  step.value = (await fdaCheck) ? "import" : "fda";
}
</script>

<template>
  <Teleport to="body">
    <!-- z-90: below Modal/ConfirmDialog (z-100) so the import step's nested
         dialogs layer above the overlay. -->
    <div
      class="fixed inset-0 z-90 bg-bg text-fg flex items-center justify-center"
    >
      <!-- TitleBar is covered; keep the frameless window draggable. -->
      <div class="absolute top-0 inset-x-0 h-titlebar" data-tauri-drag-region />
      <Transition name="welcome-step" mode="out-in">
        <div
          v-if="step === 'hello'"
          key="hello"
          class="flex flex-col items-center gap-10"
        >
          <HelloAnimation @done="helloDone = true" />
          <!-- Always rendered so the button's height is in the layout from
               first paint — only opacity/translate animate, so the hello
               can't shift when it appears. The wrapper (not the Button)
               carries the transition to avoid clashing with Button's own
               hover transition-opacity. -->
          <div
            class="transition-[opacity,translate] duration-250 ease-out"
            :class="helloDone ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'"
            :inert="!helloDone"
          >
            <Button variant="primary" @click="next">Get started</Button>
          </div>
        </div>
        <StepFda v-else-if="step === 'fda'" key="fda" @done="step = 'import'" />
        <StepImport v-else key="import" @finish="emit('close')" />
      </Transition>
    </div>
  </Teleport>
</template>

<style scoped>
.welcome-step-enter-active,
.welcome-step-leave-active {
  transition:
    opacity 250ms ease,
    transform 250ms ease;
}

.welcome-step-enter-from,
.welcome-step-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
