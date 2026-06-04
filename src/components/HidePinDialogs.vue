<script setup lang="ts">
/**
 * The PIN dialogs that gate revealing hidden SSH groups in the hosts sidebar:
 *
 *  - Set PIN   — shown the first time a group is hidden (no PIN exists yet).
 *  - Enter PIN — unlock the session to reveal hidden groups.
 *  - Reset PIN — forgot/change recovery: set a new PIN without the old one and
 *                unlock. The PIN is a soft, UI-only concealment (plaintext in the
 *                Stronghold snapshot), so there's nothing to protect by requiring
 *                the old PIN here.
 *
 * This component owns all secret interaction (`hidePinKey`) and the modal form
 * state. `locked` / `pinSet` are two-way bound to the parent, which still owns
 * group hiding and concealment. The parent drives the dialogs imperatively via
 * the exposed `openSetPin()` / `openUnlock()` methods.
 */
import { AlertTriangle } from "lucide-vue-next";
import { nextTick, onMounted, ref, type Ref } from "vue";

import { hidePinKey, loadSecret, saveSecret } from "../secrets";
import { Button, Input, Modal } from "./ui";

const locked = defineModel<boolean>("locked", { required: true });
const pinSet = defineModel<boolean>("pinSet", { required: true });

const emit = defineEmits<{
  // A brand-new PIN was just created via the "hide a group" flow; the parent
  // should now hide the pending group and refresh.
  pinCreated: [];
}>();

// Focus the input inside a freshly-opened dialog. The <Input> wrapper renders an
// <input>, so focus that after the modal mounts (matches PassphrasePromptModal).
async function focusInput(el: Ref<HTMLElement | null>) {
  await nextTick();
  el.value?.querySelector("input")?.focus();
}

// ---------- Set PIN (first time hiding a group) ----------
const setPinOpen = ref(false);
const setPinValue = ref("");
const setPinConfirm = ref("");
const setPinError = ref<string | null>(null);
const setPinEl = ref<HTMLElement | null>(null);

function openSetPin() {
  setPinValue.value = "";
  setPinConfirm.value = "";
  setPinError.value = null;
  setPinOpen.value = true;
  focusInput(setPinEl);
}

async function submitSetPin() {
  const pin = setPinValue.value.trim();
  if (!pin) {
    setPinError.value = "Enter a PIN.";
    return;
  }
  if (pin !== setPinConfirm.value.trim()) {
    setPinError.value = "PINs don't match.";
    return;
  }
  try {
    await saveSecret(hidePinKey(), pin);
    pinSet.value = true;
    locked.value = true; // conceal immediately
    setPinOpen.value = false;
    emit("pinCreated");
  } catch (err) {
    console.error("set PIN failed:", err);
    setPinError.value = `Could not save PIN: ${err}`;
  }
}

// ---------- Enter PIN (unlock) ----------
const enterPinOpen = ref(false);
const enterPinValue = ref("");
const enterPinError = ref<string | null>(null);
const enterPinEl = ref<HTMLElement | null>(null);

function openUnlock() {
  enterPinValue.value = "";
  enterPinError.value = null;
  enterPinOpen.value = true;
  focusInput(enterPinEl);
}

async function submitEnterPin() {
  try {
    const stored = await loadSecret(hidePinKey());
    if (stored != null && enterPinValue.value.trim() === stored) {
      locked.value = false;
      enterPinOpen.value = false;
    } else {
      enterPinError.value = "Incorrect PIN.";
    }
  } catch (err) {
    console.error("verify PIN failed:", err);
    enterPinError.value = `Could not verify PIN: ${err}`;
  }
}

// ---------- Reset / change PIN (forgot) ----------
const resetPinOpen = ref(false);
const resetPinValue = ref("");
const resetPinConfirm = ref("");
const resetPinError = ref<string | null>(null);
const resetPinEl = ref<HTMLElement | null>(null);

function openResetPin() {
  enterPinOpen.value = false;
  resetPinValue.value = "";
  resetPinConfirm.value = "";
  resetPinError.value = null;
  resetPinOpen.value = true;
  focusInput(resetPinEl);
}

function cancelResetPin() {
  resetPinOpen.value = false;
  resetPinValue.value = "";
  resetPinConfirm.value = "";
}

// Forgot-PIN recovery: set a brand-new PIN without the old one and unlock the
// session. Hidden groups stay hidden under the new PIN.
async function submitResetPin() {
  const pin = resetPinValue.value.trim();
  if (!pin) {
    resetPinError.value = "Enter a PIN.";
    return;
  }
  if (pin !== resetPinConfirm.value.trim()) {
    resetPinError.value = "PINs don't match.";
    return;
  }
  try {
    await saveSecret(hidePinKey(), pin);
    pinSet.value = true;
    locked.value = false;
    resetPinOpen.value = false;
    resetPinValue.value = "";
    resetPinConfirm.value = "";
  } catch (err) {
    console.error("reset PIN failed:", err);
    resetPinError.value = `Could not save PIN: ${err}`;
  }
}

onMounted(async () => {
  try {
    pinSet.value = (await loadSecret(hidePinKey())) != null;
  } catch {
    pinSet.value = false;
  }
});

defineExpose({ openSetPin, openUnlock });
</script>

<template>
  <!-- Set a PIN (first time a group is hidden) -->
  <Modal v-if="setPinOpen">
    <h2 class="m-0 text-base font-semibold text-fg">Set a PIN</h2>
    <p class="m-0 text-sm text-fg-muted leading-relaxed">
      Hidden groups are concealed until this PIN is entered. You'll need it to
      reveal them again, so keep it somewhere safe.
    </p>
    <form class="flex flex-col gap-3.5" @submit.prevent="submitSetPin">
      <div ref="setPinEl">
        <Input
          v-model="setPinValue"
          type="password"
          placeholder="New PIN"
          autocomplete="off"
        />
      </div>
      <Input
        v-model="setPinConfirm"
        type="password"
        placeholder="Confirm PIN"
        autocomplete="off"
      />
      <p v-if="setPinError" class="flex items-center gap-1 text-danger text-xs">
        <AlertTriangle :size="12" /> {{ setPinError }}
      </p>
      <div class="flex justify-end gap-2">
        <Button variant="secondary" @click="setPinOpen = false">Cancel</Button>
        <Button type="submit">Set PIN &amp; hide</Button>
      </div>
    </form>
  </Modal>

  <!-- Enter the PIN to reveal hidden groups -->
  <Modal v-if="enterPinOpen">
    <h2 class="m-0 text-base font-semibold text-fg">Enter PIN</h2>
    <p class="m-0 text-sm text-fg-muted leading-relaxed">
      Enter your PIN to reveal hidden groups and their hosts.
    </p>
    <form class="flex flex-col gap-3.5" @submit.prevent="submitEnterPin">
      <div ref="enterPinEl">
        <Input
          v-model="enterPinValue"
          type="password"
          placeholder="PIN"
          autocomplete="off"
        />
      </div>
      <p v-if="enterPinError" class="flex items-center gap-1 text-danger text-xs">
        <AlertTriangle :size="12" /> {{ enterPinError }}
      </p>
      <div class="flex items-center justify-between gap-2">
        <button
          type="button"
          class="text-xs text-fg-muted hover:text-fg cursor-pointer transition-colors duration-150"
          @click="openResetPin"
        >
          Forgot or change PIN?
        </button>
        <div class="flex gap-2">
          <Button variant="secondary" @click="enterPinOpen = false">Cancel</Button>
          <Button type="submit">Unlock</Button>
        </div>
      </div>
    </form>
  </Modal>

  <!-- Set a new PIN (forgot / change — no old PIN required) -->
  <Modal v-if="resetPinOpen">
    <h2 class="m-0 text-base font-semibold text-fg">Set a new PIN</h2>
    <p class="m-0 text-sm text-fg-muted leading-relaxed">
      This replaces your current PIN. Hidden groups stay hidden — you'll use the
      new PIN to reveal them. Keep it somewhere safe.
    </p>
    <form class="flex flex-col gap-3.5" @submit.prevent="submitResetPin">
      <div ref="resetPinEl">
        <Input
          v-model="resetPinValue"
          type="password"
          placeholder="New PIN"
          autocomplete="off"
        />
      </div>
      <Input
        v-model="resetPinConfirm"
        type="password"
        placeholder="Confirm PIN"
        autocomplete="off"
      />
      <p v-if="resetPinError" class="flex items-center gap-1 text-danger text-xs">
        <AlertTriangle :size="12" /> {{ resetPinError }}
      </p>
      <div class="flex justify-end gap-2">
        <Button variant="secondary" @click="cancelResetPin">Cancel</Button>
        <Button type="submit">Save new PIN</Button>
      </div>
    </form>
  </Modal>
</template>
