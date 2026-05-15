<script setup lang="ts">
import { Trash2 } from "lucide-vue-next";
import { computed, onMounted, reactive, ref } from "vue";

import {
  deletePortForward,
  listKeys,
  listPortForwards,
  saveHost,
  savePortForward,
  type SshAuthMethod,
  type SshHostRow,
  type SshKeyRow,
  type SshPortForwardRow,
} from "../db";
import { deleteSecret, hostPasswordKey, saveSecret } from "../secrets";
import {
  Button,
  Checkbox,
  DropdownMenu,
  ErrorMessage,
  FormRow,
  Input,
} from "./ui";

const props = defineProps<{ host: SshHostRow | null }>();
const emit = defineEmits<{ done: []; cancel: []; manageKeys: [] }>();

type WorkingForward = SshPortForwardRow & { _uiId: number; _delete: boolean };

const form = reactive({
  label: "",
  hostname: "",
  port: 22,
  username: "",
  auth_method: "agent" as SshAuthMethod,
  password: "",
  clearPassword: false,
  key_id: "" as string,
});

const keys = ref<SshKeyRow[]>([]);
const forwards = ref<WorkingForward[]>([]);
const errorText = ref<string | null>(null);
const saving = ref(false);

let nextUiId = 1;

const authOptions = [
  { value: "password", label: "Password" },
  { value: "key", label: "Private key" },
  { value: "agent", label: "ssh-agent" },
];

const forwardKindOptions = [
  { value: "local", label: "Local (-L)" },
  { value: "remote", label: "Remote (-R)" },
  { value: "dynamic", label: "Dynamic (-D)" },
];

const keyOptions = computed(() => [
  {
    value: "",
    label: keys.value.length === 0 ? "(no keys saved)" : "(select a key)",
  },
  ...keys.value.map((k) => ({
    value: String(k.id),
    label: `${k.label}${k.has_passphrase ? " 🔒" : ""}`,
  })),
]);

async function load() {
  const h = props.host;
  form.label = h?.label ?? "";
  form.hostname = h?.hostname ?? "";
  form.port = h?.port ?? 22;
  form.username = h?.username ?? "";
  form.auth_method = h?.auth_method ?? "agent";
  form.password = "";
  form.clearPassword = false;
  form.key_id = h?.key_id ? String(h.key_id) : "";
  errorText.value = null;

  try {
    keys.value = await listKeys();
  } catch (err) {
    console.error("listKeys failed:", err);
    keys.value = [];
  }

  forwards.value = [];
  if (h) {
    try {
      const fwds = await listPortForwards(h.id);
      forwards.value = fwds.map((f) => ({ ...f, _uiId: nextUiId++, _delete: false }));
    } catch (err) {
      console.error("listPortForwards failed:", err);
    }
  }
}

onMounted(load);

function addForward() {
  forwards.value.push({
    _uiId: nextUiId++,
    _delete: false,
    id: null,
    host_id: props.host?.id ?? 0,
    kind: "local",
    bind_host: "127.0.0.1",
    bind_port: 0,
    target_host: "",
    target_port: 0,
    enabled: true,
  });
}

function removeForward(f: WorkingForward) {
  f._delete = true;
}

async function onSubmit() {
  errorText.value = null;
  const auth = form.auth_method;
  if (!form.label.trim()) return (errorText.value = "Label is required");
  if (!form.hostname.trim()) return (errorText.value = "Hostname is required");
  if (!form.username.trim()) return (errorText.value = "Username is required");
  const keyId = form.key_id ? Number(form.key_id) : null;
  if (auth === "key" && keyId == null) {
    return (errorText.value = "Pick a private key (or use Manage keys to add one)");
  }

  const newPassword = auth === "password" && form.password ? form.password : null;
  const clearPassword = auth === "password" && form.clearPassword;
  const hasPassword =
    auth === "password" &&
    !clearPassword &&
    (newPassword != null || !!props.host?.has_password);

  saving.value = true;
  try {
    const savedId = await saveHost({
      id: props.host?.id ?? null,
      label: form.label.trim(),
      hostname: form.hostname.trim(),
      port: form.port || 22,
      username: form.username.trim(),
      auth_method: auth,
      key_id: auth === "key" ? keyId : null,
      has_password: hasPassword,
    });

    if (newPassword != null) {
      await saveSecret(hostPasswordKey(savedId), newPassword);
    } else if (clearPassword) {
      await deleteSecret(hostPasswordKey(savedId)).catch(() => undefined);
    }

    for (const f of forwards.value) {
      if (f._delete && f.id != null) {
        await deletePortForward(f.id);
        continue;
      }
      if (f._delete) continue;
      await savePortForward({
        id: f.id ?? null,
        host_id: savedId,
        kind: f.kind,
        bind_host: f.bind_host,
        bind_port: f.bind_port,
        target_host: f.kind === "dynamic" ? null : f.target_host || null,
        target_port: f.kind === "dynamic" ? null : f.target_port || null,
        enabled: f.enabled,
      });
    }
    emit("done");
  } catch (err) {
    errorText.value = `Save failed: ${err}`;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="absolute inset-0 flex flex-col gap-3.5 px-9 pt-8 pb-6 overflow-y-auto text-fg">
    <Button variant="ghost" @click="emit('cancel')">← Hosts</Button>
    <h2 class="m-0 text-base font-medium tracking-wide text-fg">
      {{ host ? `Edit host: ${host.label}` : "Add host" }}
    </h2>
    <form class="flex flex-col gap-2.5 max-w-180" novalidate @submit.prevent="onSubmit">
      <FormRow label="Label" html-for="ssh-host-label">
        <Input id="ssh-host-label" v-model="form.label" />
      </FormRow>
      <FormRow label="Hostname" html-for="ssh-host-hostname">
        <Input id="ssh-host-hostname" v-model="form.hostname" />
      </FormRow>
      <FormRow label="Port" html-for="ssh-host-port">
        <Input id="ssh-host-port" type="number" v-model="form.port" min="1" max="65535" />
      </FormRow>
      <FormRow label="Username" html-for="ssh-host-username">
        <Input id="ssh-host-username" v-model="form.username" />
      </FormRow>
      <FormRow label="Auth method" html-for="ssh-host-auth">
        <DropdownMenu
          id="ssh-host-auth"
          :options="authOptions"
          :model-value="form.auth_method"
          @update:model-value="form.auth_method = $event as SshAuthMethod"
        />
      </FormRow>

      <FormRow
        label="Password"
        html-for="ssh-host-password"
        :show="form.auth_method === 'password'"
      >
        <Input
          id="ssh-host-password"
          type="password"
          v-model="form.password"
          placeholder="(leave blank to keep existing)"
        />
        <Checkbox v-model="form.clearPassword">Clear saved password</Checkbox>
      </FormRow>

      <FormRow
        label="Private key"
        html-for="ssh-host-key"
        :show="form.auth_method === 'key'"
      >
        <DropdownMenu
          id="ssh-host-key"
          :options="keyOptions"
          :model-value="form.key_id"
          @update:model-value="form.key_id = String($event)"
        />
        <Button variant="link" @click="emit('manageKeys')">Manage keys</Button>
      </FormRow>

      <div class="flex flex-col gap-1.5 mt-1.5 pt-3 border-t border-border">
        <div class="flex justify-between items-center">
          <h3 class="m-0 text-sm font-medium text-fg">Port forwards</h3>
          <Button variant="link" @click="addForward">+ Add forward</Button>
        </div>
        <div class="flex flex-col gap-1.5">
          <template v-for="f in forwards" :key="f._uiId">
            <div v-if="!f._delete" class="flex items-center gap-1.5 flex-wrap">
              <DropdownMenu
                class="basis-32 grow-0"
                :options="forwardKindOptions"
                :model-value="f.kind"
                @update:model-value="f.kind = $event as SshPortForwardRow['kind']"
              />
              <input
                type="text"
                placeholder="bind host"
                size="14"
                v-model="f.bind_host"
                class="bg-surface-1 border border-border text-fg rounded-md px-1.5 py-1 text-xs font-mono"
              />
              <input
                type="number"
                placeholder="bind port"
                min="1"
                max="65535"
                style="width: 7ch"
                :value="f.bind_port || ''"
                class="bg-surface-1 border border-border text-fg rounded-md px-1.5 py-1 text-xs font-mono"
                @input="f.bind_port = Number(($event.target as HTMLInputElement).value) || 0"
              />
              <template v-if="f.kind !== 'dynamic'">
                <span class="text-fg-subtle text-xs">→</span>
                <input
                  type="text"
                  placeholder="target host"
                  size="14"
                  :value="f.target_host ?? ''"
                  class="bg-surface-1 border border-border text-fg rounded-md px-1.5 py-1 text-xs font-mono"
                  @input="f.target_host = ($event.target as HTMLInputElement).value"
                />
                <input
                  type="number"
                  placeholder="target port"
                  min="1"
                  max="65535"
                  style="width: 7ch"
                  :value="f.target_port ?? ''"
                  class="bg-surface-1 border border-border text-fg rounded-md px-1.5 py-1 text-xs font-mono"
                  @input="f.target_port = Number(($event.target as HTMLInputElement).value) || 0"
                />
              </template>
              <Checkbox v-model="f.enabled" class="ml-auto">Enabled</Checkbox>
              <Button size="sm" variant="danger" title="Remove forward" @click="removeForward(f)">
                <Trash2 :size="14" />
              </Button>
            </div>
          </template>
          <div
            v-if="forwards.filter((f) => !f._delete).length === 0"
            class="text-fg-subtle text-xs py-2"
          >
            No port forwards configured.
          </div>
        </div>
      </div>

      <ErrorMessage v-if="errorText">{{ errorText }}</ErrorMessage>

      <div class="flex gap-2 mt-2">
        <Button type="submit" :disabled="saving">Save</Button>
        <Button variant="secondary" @click="emit('cancel')">Cancel</Button>
      </div>
    </form>
  </div>
</template>
