<script setup lang="ts">
import { ref, watch } from "vue";

import { type SshHostRow, type SshKeyRow } from "../db";
import { useTabs } from "../state/tabs";
import CustomTheme from "./CustomTheme.vue";
import HostEdit from "./HostEdit.vue";
import HostList from "./HostList.vue";
import KeyEdit from "./KeyEdit.vue";
import KeyList from "./KeyList.vue";
import Settings from "./Settings.vue";

type Pane = "home" | "settings" | "custom" | "host-edit" | "keys" | "key-edit";

const pane = ref<Pane>("home");
const editingHost = ref<SshHostRow | null>(null);
const editingKey = ref<SshKeyRow | null>(null);
const hostListRef = ref<InstanceType<typeof HostList> | null>(null);
const keyListRef = ref<InstanceType<typeof KeyList> | null>(null);

const { active } = useTabs();

// When the user navigates back to the home tab, refresh whichever pane is
// currently visible. Without this, switching tabs leaves stale data on the
// hosts/keys lists (they only re-fetch on mount and on explicit nav).
watch(active, (a) => {
  if (a?.kind !== "home") return;
  if (pane.value === "home") void hostListRef.value?.refresh();
  else if (pane.value === "keys") void keyListRef.value?.refresh();
});

function openHostEditor(h: SshHostRow | null) {
  editingHost.value = h;
  pane.value = "host-edit";
}

function openKeyEditor(k: SshKeyRow | null) {
  editingKey.value = k;
  pane.value = "key-edit";
}

// Returning from an editor must re-fetch the list: the lists are kept mounted
// under v-show, so onMounted(refresh) only ever runs once and a freshly
// saved/edited row would otherwise stay invisible until a tab switch.
function closeHostEditor() {
  pane.value = "home";
  void hostListRef.value?.refresh();
}

function closeKeyEditor() {
  pane.value = "keys";
  void keyListRef.value?.refresh();
}
</script>

<template>
  <div class="absolute inset-0 z-10 overflow-hidden select-none">
    <HostList
      v-show="pane === 'home'"
      ref="hostListRef"
      @add-host="openHostEditor(null)"
      @edit-host="(h) => openHostEditor(h)"
      @manage-keys="pane = 'keys'"
      @open-settings="pane = 'settings'"
    />
    <HostEdit
      v-if="pane === 'host-edit'"
      :host="editingHost"
      @done="closeHostEditor"
      @cancel="closeHostEditor"
      @manage-keys="pane = 'keys'"
    />
    <KeyList
      v-show="pane === 'keys'"
      ref="keyListRef"
      @back="pane = 'home'"
      @add-key="openKeyEditor(null)"
      @edit-key="(k) => openKeyEditor(k)"
    />
    <KeyEdit
      v-if="pane === 'key-edit'"
      :key-row="editingKey"
      @done="closeKeyEditor"
      @cancel="closeKeyEditor"
    />
    <Settings
      v-show="pane === 'settings'"
      @back="pane = 'home'"
      @open-custom="pane = 'custom'"
    />
    <CustomTheme
      v-show="pane === 'custom'"
      @back="pane = 'settings'"
    />
  </div>
</template>
