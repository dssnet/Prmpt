<script setup lang="ts">
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Eye,
  EyeOff,
  Lock,
  Plus,
  Trash2,
} from "lucide-vue-next";
import { computed, onMounted, reactive, ref } from "vue";

import {
  deletePortForward,
  listGroups,
  listKeys,
  listPortForwards,
  saveHost,
  savePortForward,
  type SshAuthMethod,
  type SshForwardKind,
  type SshGroupRow,
  type SshHostRow,
  type SshKeyRow,
  type SshPortForwardRow,
} from "../db";
import { flattenForPicker } from "../lib/groupTree";
import { deleteSecret, hostPasswordKey, saveSecret } from "../secrets";
import {
  Badge,
  Button,
  ConfirmDialog,
  DropdownMenu,
  ErrorMessage,
  FormRow,
  Input,
  Switch,
} from "./ui";

const props = defineProps<{ host: SshHostRow | null }>();
const emit = defineEmits<{ done: []; cancel: []; manageKeys: [] }>();

type WorkingForward = SshPortForwardRow & { _uiId: number; _delete: boolean };
type PwMode = "saved" | "replace" | "empty";
/** Maps onto the `disable_sftp` / `disable_ssh` host flags — a single select
 *  keeps "both disabled" unrepresentable. */
type ConnectionMode = "both" | "shell" | "sftp";

const form = reactive({
  label: "",
  hostname: "",
  port: 22,
  username: "",
  auth_method: "agent" as SshAuthMethod,
  password: "",
  key_id: "" as string,
  group_id: "" as string,
  connection_mode: "both" as ConnectionMode,
});

const pwMode = ref<PwMode>("replace");
const showPw = ref(false);

const keys = ref<SshKeyRow[]>([]);
const groups = ref<SshGroupRow[]>([]);
const forwards = ref<WorkingForward[]>([]);
const errorText = ref<string | null>(null);
const saving = ref(false);
const bodyRef = ref<HTMLElement | null>(null);

type ForwardErrors = { bind_port?: string; target_host?: string; target_port?: string };
const errors = reactive<{
  label?: string;
  hostname?: string;
  username?: string;
  port?: string;
  keyId?: string;
  forwards: Record<number, ForwardErrors>;
}>({ forwards: {} });

let nextUiId = 1;

const authOptions = [
  { value: "password", label: "Password" },
  { value: "key", label: "Private key" },
  { value: "agent", label: "ssh-agent" },
];

const connectionModeOptions = [
  { value: "both", label: "Shell + SFTP" },
  { value: "shell", label: "Shell only" },
  { value: "sftp", label: "SFTP only" },
];

const CONNECTION_MODE_HELP: Record<ConnectionMode, string> = {
  both: "Opens a terminal with the file browser panel alongside it.",
  shell: "Opens a terminal only — the file browser panel stays hidden.",
  sftp: "Opens the file browser only — no terminal. For accounts restricted to SFTP (e.g. ForceCommand internal-sftp).",
};

const AUTH_HELP: Record<SshAuthMethod, string> = {
  agent:
    "Uses keys already loaded in your SSH agent. No password or key file needed — the agent handles authentication for you.",
  key: "Authenticate with a key managed by Prmpt. Pick one below, or add a new key from Manage keys.",
  password:
    "Prmpt stores the password securely and sends it when connecting.",
};

const FWD: Record<
  SshForwardKind,
  {
    name: string;
    tag: string;
    srcLabel: string;
    srcNote: string;
    dstLabel: string;
    dstNote: string;
  }
> = {
  local: {
    name: "Local",
    tag: "-L",
    srcLabel: "Listen on my machine",
    srcNote: "A port on this computer…",
    dstLabel: "Forward to",
    dstNote: "…reached from the SSH server.",
  },
  remote: {
    name: "Remote",
    tag: "-R",
    srcLabel: "Listen on the server",
    srcNote: "A port on the SSH server…",
    dstLabel: "Forward to",
    dstNote: "…reached from this computer.",
  },
  dynamic: {
    name: "Dynamic",
    tag: "-D",
    srcLabel: "SOCKS proxy on my machine",
    srcNote: "Acts as a SOCKS5 proxy — apps tunnel through the server.",
    dstLabel: "",
    dstNote: "",
  },
};

const groupOptions = computed(() => [
  { value: "", label: "Ungrouped" },
  ...flattenForPicker(groups.value),
]);

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

const activeCount = computed(
  () => forwards.value.filter((f) => !f._delete && f.enabled).length,
);
const visibleForwards = computed(() => forwards.value.filter((f) => !f._delete));

const saveSummary = computed(() =>
  form.hostname
    ? `${form.username || "you"}@${form.hostname}:${form.port}`
    : "Fill in a hostname to save",
);

// Snapshot of the form taken right after load(); used to detect unsaved edits
// so leaving the page (Cancel / back / Manage keys) can warn before discarding.
const baseline = ref("");

function serialize(): string {
  return JSON.stringify({
    label: form.label,
    hostname: form.hostname,
    port: form.port,
    username: form.username,
    auth_method: form.auth_method,
    key_id: form.key_id,
    group_id: form.group_id,
    connection_mode: form.connection_mode,
    password: form.password,
    pwMode: pwMode.value,
    forwards: forwards.value
      .filter((f) => !f._delete)
      .map((f) => ({
        kind: f.kind,
        bind_host: f.bind_host,
        bind_port: f.bind_port,
        target_host: f.target_host,
        target_port: f.target_port,
        enabled: f.enabled,
      })),
    deleted: forwards.value.some((f) => f._delete && f.id != null),
  });
}

// "" baseline means load() hasn't snapshotted yet — treat as pristine to
// avoid a spurious dirty flash on first render. Drives the footer warning that
// leaving (Cancel / back / Manage keys) discards unsaved edits.
const dirty = computed(() => baseline.value !== "" && serialize() !== baseline.value);

// Unsaved-changes guard. Navigating away (Cancel / back / Manage keys) runs
// through requestLeave: if the form is clean it leaves immediately, otherwise
// it stages the action and opens the confirm dialog.
const leaveDialogOpen = ref(false);
let pendingLeave: (() => void) | null = null;

function requestLeave(action: () => void) {
  if (!dirty.value) {
    action();
    return;
  }
  pendingLeave = action;
  leaveDialogOpen.value = true;
}

function confirmLeave() {
  leaveDialogOpen.value = false;
  const action = pendingLeave;
  pendingLeave = null;
  action?.();
}

function dismissLeave() {
  leaveDialogOpen.value = false;
  pendingLeave = null;
}

const onCancel = () => requestLeave(() => emit("cancel"));
const onManageKeys = () => requestLeave(() => emit("manageKeys"));

const isPort = (v: unknown) =>
  v !== "" && v != null && /^\d+$/.test(String(v)) && +v >= 1 && +v <= 65535;

function forwardSummary(f: WorkingForward) {
  const bind = `${f.bind_host || "127.0.0.1"}:${f.bind_port || "•"}`;
  if (f.kind === "dynamic") return `SOCKS on ${bind}`;
  return `${bind} → ${f.target_host || "•"}:${f.target_port || "•"}`;
}

async function load() {
  const h = props.host;
  form.label = h?.label ?? "";
  form.hostname = h?.hostname ?? "";
  form.port = h?.port ?? 22;
  form.username = h?.username ?? "";
  form.auth_method = h?.auth_method ?? "agent";
  form.password = "";
  form.key_id = h?.key_id ? String(h.key_id) : "";
  form.group_id = h?.group_id ? String(h.group_id) : "";
  // Both-set rows are only possible by hand-editing the DB; collapse to
  // "sftp" (the backend treats disable_ssh as authoritative) — saving
  // normalizes them.
  form.connection_mode = h?.disable_ssh ? "sftp" : h?.disable_sftp ? "shell" : "both";
  pwMode.value = h?.has_password ? "saved" : "replace";
  showPw.value = false;
  errorText.value = null;

  try {
    keys.value = await listKeys();
  } catch (err) {
    console.error("listKeys failed:", err);
    keys.value = [];
  }

  try {
    groups.value = await listGroups();
  } catch (err) {
    console.error("listGroups failed:", err);
    groups.value = [];
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

  baseline.value = serialize();
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

function validate(): boolean {
  errors.label = undefined;
  errors.hostname = undefined;
  errors.username = undefined;
  errors.port = undefined;
  errors.keyId = undefined;
  errors.forwards = {};
  let ok = true;

  if (!form.label.trim()) (errors.label = "Label is required."), (ok = false);
  if (!form.hostname.trim()) (errors.hostname = "Hostname is required."), (ok = false);
  if (!form.username.trim()) (errors.username = "Username is required."), (ok = false);
  if (!isPort(form.port)) (errors.port = "Enter a port between 1 and 65535."), (ok = false);
  if (form.auth_method === "key" && !form.key_id) {
    errors.keyId = "Pick a private key (or add one from Manage keys).";
    ok = false;
  }

  for (const f of forwards.value) {
    if (f._delete) continue;
    const fe: ForwardErrors = {};
    if (!isPort(f.bind_port)) fe.bind_port = "Port must be 1–65535.";
    if (f.kind !== "dynamic") {
      if (!(f.target_host ?? "").trim()) fe.target_host = "Target host required.";
      else if (!isPort(f.target_port)) fe.target_port = "Port must be 1–65535.";
    }
    if (Object.keys(fe).length) {
      errors.forwards[f._uiId] = fe;
      ok = false;
    }
  }
  return ok;
}

async function onSubmit() {
  errorText.value = null;
  if (!validate()) {
    bodyRef.value?.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  const auth = form.auth_method;
  const keyId = form.key_id ? Number(form.key_id) : null;

  const clearPassword = auth === "password" && pwMode.value === "empty";
  const newPassword =
    auth === "password" && pwMode.value === "replace" && form.password ? form.password : null;
  const hasPassword =
    auth === "password" &&
    (clearPassword ? false : newPassword != null ? true : !!props.host?.has_password);

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
      group_id: form.group_id ? Number(form.group_id) : null,
      has_password: hasPassword,
      disable_sftp: form.connection_mode === "shell",
      disable_ssh: form.connection_mode === "sftp",
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
  <form
    class="absolute inset-0 flex flex-col text-fg"
    novalidate
    @submit.prevent="onSubmit"
  >
    <!-- scrollable body -->
    <div ref="bodyRef" class="flex-1 overflow-y-auto px-9 pt-2 pb-6">
      <div class="flex flex-col gap-2.5">
        <Button variant="ghost" @click="onCancel">← Hosts</Button>

        <!-- Connection -->
        <section class="border border-border rounded-lg bg-surface-1">
          <header class="px-3.5 pt-2.5 pb-2 border-b border-border">
            <h3 class="m-0 text-sm font-semibold text-fg">Connection</h3>
          </header>
          <div class="px-3.5 py-3 flex flex-col gap-2.5">
            <FormRow stack label="Label" html-for="ssh-host-label">
              <Input id="ssh-host-label" v-model="form.label" placeholder="e.g. Production web server" />
              <p v-if="errors.label" class="flex items-center gap-1 text-danger text-xs mt-1">
                <AlertTriangle :size="12" /> {{ errors.label }}
              </p>
              <p v-else class="text-xs text-fg-subtle mt-1">
                A friendly name shown in your hosts list.
              </p>
            </FormRow>

            <div class="grid grid-cols-[1fr_120px] gap-2.5">
              <FormRow stack label="Hostname" html-for="ssh-host-hostname">
                <Input id="ssh-host-hostname" v-model="form.hostname" placeholder="example.com or 10.0.0.4" />
                <p v-if="errors.hostname" class="flex items-center gap-1 text-danger text-xs mt-1">
                  <AlertTriangle :size="12" /> {{ errors.hostname }}
                </p>
              </FormRow>
              <FormRow stack label="Port" html-for="ssh-host-port">
                <Input id="ssh-host-port" type="number" v-model="form.port" min="1" max="65535" />
                <p v-if="errors.port" class="flex items-center gap-1 text-danger text-xs mt-1">
                  <AlertTriangle :size="12" /> {{ errors.port }}
                </p>
              </FormRow>
            </div>

            <FormRow stack label="Username" html-for="ssh-host-username">
              <Input id="ssh-host-username" v-model="form.username" placeholder="root" />
              <p v-if="errors.username" class="flex items-center gap-1 text-danger text-xs mt-1">
                <AlertTriangle :size="12" /> {{ errors.username }}
              </p>
            </FormRow>

            <FormRow stack label="Group" html-for="ssh-host-group">
              <DropdownMenu
                id="ssh-host-group"
                :options="groupOptions"
                :model-value="form.group_id"
                @update:model-value="form.group_id = String($event)"
              />
              <p class="text-xs text-fg-subtle mt-1">
                Organize this host under a group. Create and manage groups in the
                sidebar of the hosts list.
              </p>
            </FormRow>
          </div>
        </section>

        <!-- Authentication -->
        <section class="border border-border rounded-lg bg-surface-1">
          <header class="px-3.5 pt-2.5 pb-2 border-b border-border">
            <h3 class="m-0 text-sm font-semibold text-fg">Authentication</h3>
          </header>
          <div class="px-3.5 py-3 flex flex-col gap-2.5">
            <FormRow stack label="Method" html-for="ssh-host-auth">
              <DropdownMenu
                id="ssh-host-auth"
                :options="authOptions"
                :model-value="form.auth_method"
                @update:model-value="form.auth_method = $event as SshAuthMethod"
              />
            </FormRow>

            <!-- Password -->
            <FormRow stack label="Password" :show="form.auth_method === 'password'">
              <div
                v-if="pwMode === 'saved'"
                class="flex items-center gap-3 bg-bg border border-border rounded-md px-3 py-2.5"
              >
                <span class="grid place-items-center w-8 h-8 shrink-0 rounded-md bg-surface-2 text-accent">
                  <Lock :size="16" />
                </span>
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium text-fg">Password saved</div>
                  <div class="text-xs text-fg-subtle mt-0.5">Stored securely.</div>
                </div>
                <div class="flex gap-2">
                  <Button variant="secondary" size="sm" @click="form.password = ''; pwMode = 'replace'">
                    Replace
                  </Button>
                  <Button variant="danger" size="sm" @click="form.password = ''; pwMode = 'empty'">
                    Remove
                  </Button>
                </div>
              </div>

              <div v-else-if="pwMode === 'empty'" class="flex items-center gap-2 text-xs text-fg-muted py-1">
                <span>Saved password will be removed when you save.</span>
                <Button variant="link" @click="pwMode = 'saved'">Undo</Button>
              </div>

              <template v-else>
                <div class="relative">
                  <Input
                    :type="showPw ? 'text' : 'password'"
                    v-model="form.password"
                    :placeholder="host?.has_password ? 'Enter new password' : 'Password'"
                  />
                  <button
                    type="button"
                    class="absolute right-1.5 top-1/2 -translate-y-1/2 grid place-items-center w-7 h-7 rounded text-fg-subtle hover:text-fg-muted cursor-pointer"
                    :title="showPw ? 'Hide' : 'Show'"
                    @click="showPw = !showPw"
                  >
                    <EyeOff v-if="showPw" :size="16" />
                    <Eye v-else :size="16" />
                  </button>
                </div>
                <div v-if="host?.has_password" class="mt-1.5">
                  <Button variant="link" @click="form.password = ''; pwMode = 'saved'">
                    Cancel — keep saved password
                  </Button>
                </div>
              </template>
            </FormRow>

            <!-- Private key -->
            <FormRow stack :show="form.auth_method === 'key'">
              <div class="flex items-center justify-between mb-1">
                <label class="text-fg-muted text-sm" for="ssh-host-key">Private key</label>
                <Button variant="link" @click="onManageKeys">
                  <span class="inline-flex items-center gap-1">
                    Manage keys <ArrowUpRight :size="13" />
                  </span>
                </Button>
              </div>
              <DropdownMenu
                id="ssh-host-key"
                :options="keyOptions"
                :model-value="form.key_id"
                @update:model-value="form.key_id = String($event)"
              />
              <p v-if="errors.keyId" class="flex items-center gap-1 text-danger text-xs mt-1">
                <AlertTriangle :size="12" /> {{ errors.keyId }}
              </p>
            </FormRow>

            <!-- Auth help callout -->
            <div class="flex gap-2.5 bg-bg border border-border rounded-md px-3 py-2.5 text-xs text-fg-muted leading-relaxed">
              <span class="shrink-0 w-1.5 h-1.5 rounded-full bg-accent mt-1.5" />
              <span>{{ AUTH_HELP[form.auth_method] }}</span>
            </div>
          </div>
        </section>

        <!-- Port forwarding -->
        <section class="border border-border rounded-lg bg-surface-1">
          <header class="flex items-center justify-between gap-2.5 px-3.5 pt-2.5 pb-2 border-b border-border">
            <h3 class="m-0 text-sm font-semibold text-fg">Port forwarding</h3>
            <div class="flex items-center gap-2.5">
              <Badge>{{ activeCount }} active</Badge>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 text-accent text-xs font-medium cursor-pointer hover:opacity-80 transition-opacity duration-150"
                @click="addForward"
              >
                <Plus :size="14" /> Add forward
              </button>
            </div>
          </header>
          <div class="px-3.5 py-3 flex flex-col gap-2">
            <div
              v-if="visibleForwards.length === 0"
              class="border border-dashed border-border rounded-lg bg-bg px-5 py-5 text-center text-xs text-fg-subtle leading-relaxed"
            >
              No forwards yet.<br />Add one to tunnel a port through this SSH connection.
            </div>

            <div
              v-for="f in visibleForwards"
              :key="f._uiId"
              class="border border-border rounded-lg bg-bg overflow-hidden transition-opacity duration-150"
              :class="{ 'opacity-50': !f.enabled }"
            >
              <!-- head -->
              <div class="flex items-center gap-3 px-3.5 py-3 border-b border-border">
                <div class="inline-flex gap-1 bg-surface-1 border border-border rounded-md p-0.5">
                  <button
                    v-for="(meta, kind) in FWD"
                    :key="kind"
                    type="button"
                    class="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-colors duration-150"
                    :class="
                      f.kind === kind
                        ? 'bg-surface-2 text-fg'
                        : 'text-fg-muted hover:text-fg'
                    "
                    @click="f.kind = kind as SshForwardKind"
                  >
                    {{ meta.name }}
                    <span class="font-mono" :class="f.kind === kind ? 'text-accent' : 'text-fg-subtle'">
                      {{ meta.tag }}
                    </span>
                  </button>
                </div>
                <span class="flex-1 min-w-0 truncate font-mono text-xs text-fg-muted">
                  {{ forwardSummary(f) }}
                </span>
                <Switch v-model="f.enabled" />
                <Button size="sm" variant="danger" title="Remove forward" @click="removeForward(f)">
                  <Trash2 :size="14" />
                </Button>
              </div>

              <!-- body -->
              <div class="px-3.5 py-3">
                <div
                  class="grid gap-3.5 items-end"
                  :class="f.kind === 'dynamic' ? 'grid-cols-1' : 'grid-cols-[1fr_auto_1fr]'"
                >
                  <div class="min-w-0">
                    <div class="text-xs font-semibold text-fg-muted">{{ FWD[f.kind].srcLabel }}</div>
                    <div class="text-xs text-fg-subtle mt-0.5 mb-2 leading-snug">{{ FWD[f.kind].srcNote }}</div>
                    <div class="grid grid-cols-[1fr_78px] gap-2">
                      <input
                        type="text"
                        placeholder="127.0.0.1"
                        v-model="f.bind_host"
                        aria-label="bind address"
                        class="bg-surface-1 border border-border text-fg rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-border-strong"
                      />
                      <input
                        type="number"
                        placeholder="port"
                        min="1"
                        max="65535"
                        :value="f.bind_port || ''"
                        aria-label="bind port"
                        class="bg-surface-1 border text-fg rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none"
                        :class="errors.forwards[f._uiId]?.bind_port ? 'border-danger' : 'border-border focus:border-border-strong'"
                        @input="f.bind_port = Number(($event.target as HTMLInputElement).value) || 0"
                      />
                    </div>
                    <p
                      v-if="errors.forwards[f._uiId]?.bind_port"
                      class="flex items-center gap-1 text-danger text-xs mt-1.5"
                    >
                      <AlertTriangle :size="12" /> {{ errors.forwards[f._uiId]?.bind_port }}
                    </p>
                  </div>

                  <template v-if="f.kind !== 'dynamic'">
                    <ArrowRight :size="16" class="text-fg-subtle mb-2" />
                    <div class="min-w-0">
                      <div class="text-xs font-semibold text-fg-muted">{{ FWD[f.kind].dstLabel }}</div>
                      <div class="text-xs text-fg-subtle mt-0.5 mb-2 leading-snug">{{ FWD[f.kind].dstNote }}</div>
                      <div class="grid grid-cols-[1fr_78px] gap-2">
                        <input
                          type="text"
                          placeholder="target.host"
                          :value="f.target_host ?? ''"
                          aria-label="target host"
                          class="bg-surface-1 border text-fg rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none"
                          :class="errors.forwards[f._uiId]?.target_host ? 'border-danger' : 'border-border focus:border-border-strong'"
                          @input="f.target_host = ($event.target as HTMLInputElement).value"
                        />
                        <input
                          type="number"
                          placeholder="port"
                          min="1"
                          max="65535"
                          :value="f.target_port ?? ''"
                          aria-label="target port"
                          class="bg-surface-1 border text-fg rounded-md px-2 py-1.5 text-xs font-mono focus:outline-none"
                          :class="errors.forwards[f._uiId]?.target_port ? 'border-danger' : 'border-border focus:border-border-strong'"
                          @input="f.target_port = Number(($event.target as HTMLInputElement).value) || 0"
                        />
                      </div>
                      <p
                        v-if="errors.forwards[f._uiId]?.target_host || errors.forwards[f._uiId]?.target_port"
                        class="flex items-center gap-1 text-danger text-xs mt-1.5"
                      >
                        <AlertTriangle :size="12" />
                        {{ errors.forwards[f._uiId]?.target_host || errors.forwards[f._uiId]?.target_port }}
                      </p>
                    </div>
                  </template>
                </div>
              </div>
            </div>

          </div>
        </section>

        <!-- Advanced -->
        <section class="border border-border rounded-lg bg-surface-1">
          <header class="px-3.5 pt-2.5 pb-2 border-b border-border">
            <h3 class="m-0 text-sm font-semibold text-fg">Advanced</h3>
          </header>
          <div class="px-3.5 py-3 flex flex-col gap-2.5">
            <FormRow stack label="Connection mode" html-for="ssh-host-connection-mode">
              <DropdownMenu
                id="ssh-host-connection-mode"
                :options="connectionModeOptions"
                :model-value="form.connection_mode"
                @update:model-value="form.connection_mode = $event as ConnectionMode"
              />
              <p class="text-xs text-fg-subtle mt-1">
                {{ CONNECTION_MODE_HELP[form.connection_mode] }}
              </p>
            </FormRow>
          </div>
        </section>

        <ErrorMessage v-if="errorText">{{ errorText }}</ErrorMessage>
      </div>
    </div>

    <!-- pinned footer -->
    <div class="flex-none flex items-center gap-3 border-t border-border bg-bg px-9 py-3">
      <span class="flex-1 min-w-0 text-xs text-fg-muted flex items-center gap-1.5">
        <template v-if="dirty">
          <AlertTriangle :size="12" class="text-danger shrink-0" />
          Unsaved changes — leaving this page will discard them.
        </template>
      </span>
      <span class="text-xs text-fg-subtle">{{ saveSummary }}</span>
      <Button variant="secondary" @click="onCancel">Cancel</Button>
      <Button type="submit" :disabled="saving">Save host</Button>
    </div>

    <ConfirmDialog
      :open="leaveDialogOpen"
      title="Discard unsaved changes?"
      message="You've made changes that haven't been saved. Leaving this page will discard them."
      confirm-label="Discard changes"
      cancel-label="Keep editing"
      @confirm="confirmLeave"
      @cancel="dismissLeave"
    />
  </form>
</template>
