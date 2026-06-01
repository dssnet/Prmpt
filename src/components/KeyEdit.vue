<script setup lang="ts">
import { AlertTriangle, Eye, EyeOff, Lock, Upload } from "lucide-vue-next";
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";

import { saveKey, type SshKeyRow } from "../db";
import { inspectSshKey } from "../ipc";
import { deleteSecret, keyPassphraseKey, keyPrivateKey, saveSecret } from "../secrets";
import {
  Button,
  ConfirmDialog,
  ErrorMessage,
  FormRow,
  Input,
  Textarea,
} from "./ui";

const props = defineProps<{ keyRow: SshKeyRow | null }>();
const emit = defineEmits<{ done: []; cancel: [] }>();

type PpMode = "saved" | "replace" | "empty";

const form = reactive({
  label: "",
  privateKey: "",
  passphrase: "",
  publicKey: "",
});

const ppMode = ref<PpMode>("replace");
const showPp = ref(false);

// Private key: an existing key already has its private key stored in the
// keychain, so it starts "saved" (with a Replace action) rather than showing
// an empty textarea. New keys start in "replace" so the textarea is shown.
const pkMode = ref<"saved" | "replace">("replace");

const errorText = ref<string | null>(null);
const saving = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const bodyRef = ref<HTMLElement | null>(null);

const errors = reactive<{ label?: string; privateKey?: string }>({});

// Tracks whether the *pasted/imported* private key in the textarea requires
// a passphrase. null means "no key text to inspect yet". Updated via a
// debounced call to the backend so typing doesn't fire an IPC per keystroke.
const keyEncrypted = ref<boolean | null>(null);
let inspectTimer: number | null = null;
let inspectSeq = 0;

watch(
  () => form.privateKey,
  (text) => {
    const trimmed = text.trim();
    if (inspectTimer != null) {
      window.clearTimeout(inspectTimer);
      inspectTimer = null;
    }
    if (!trimmed) {
      keyEncrypted.value = null;
      return;
    }
    const seq = ++inspectSeq;
    inspectTimer = window.setTimeout(async () => {
      try {
        const info = await inspectSshKey(trimmed);
        if (seq !== inspectSeq) return;
        keyEncrypted.value = info.valid ? info.encrypted : null;
      } catch {
        if (seq !== inspectSeq) return;
        keyEncrypted.value = null;
      }
    }, 200);
  },
);

onUnmounted(() => {
  if (inspectTimer != null) window.clearTimeout(inspectTimer);
});

function load() {
  const k = props.keyRow;
  form.label = k?.label ?? "";
  form.privateKey = "";
  form.passphrase = "";
  form.publicKey = k?.public_key ?? "";
  ppMode.value = k?.has_passphrase ? "saved" : "replace";
  pkMode.value = k ? "saved" : "replace";
  showPp.value = false;
  errorText.value = null;
  keyEncrypted.value = null;
  errors.label = undefined;
  errors.privateKey = undefined;
  baseline.value = serialize();
}

onMounted(load);

// ---- unsaved-changes guard -------------------------------------------------

const baseline = ref("");

function serialize(): string {
  return JSON.stringify({
    label: form.label,
    privateKey: form.privateKey,
    passphrase: form.passphrase,
    publicKey: form.publicKey,
    ppMode: ppMode.value,
  });
}

const dirty = computed(() => baseline.value !== "" && serialize() !== baseline.value);

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

const keySummary = computed(() =>
  form.label.trim() ? `Key “${form.label.trim()}”` : "Name this key to save",
);

// ---- import / submit -------------------------------------------------------

function onImportClick() {
  if (fileInput.value) {
    fileInput.value.value = "";
    fileInput.value.click();
  }
}

function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onerror = () => {
    errorText.value = `Read failed: ${reader.error?.message ?? "unknown"}`;
  };
  reader.onload = () => {
    const text = String(reader.result ?? "").replace(/\r\n/g, "\n");
    const trimmed = text.trim();
    // OpenSSH/PEM private keys start with -----BEGIN ...-----. If the user
    // accidentally picks a .pub instead, route it into the public field.
    const looksLikePublic = /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-)/.test(trimmed);
    if (looksLikePublic) {
      form.publicKey = trimmed;
    } else {
      form.privateKey = text;
    }
    if (!form.label.trim()) {
      form.label = file.name.replace(/\.(pub|pem|key)$/i, "");
    }
    errorText.value = null;
  };
  reader.readAsText(file);
}

function validate(): boolean {
  errors.label = undefined;
  errors.privateKey = undefined;
  let ok = true;
  if (!form.label.trim()) {
    errors.label = "Label is required.";
    ok = false;
  }
  if (!props.keyRow && !form.privateKey.trim()) {
    errors.privateKey = "Private key is required.";
    ok = false;
  }
  return ok;
}

async function onSubmit() {
  errorText.value = null;
  if (!validate()) {
    bodyRef.value?.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  const privateKey = form.privateKey.trim();
  const clearPassphrase = ppMode.value === "empty";
  const newPassphrase = ppMode.value === "replace" && form.passphrase ? form.passphrase : null;
  const hasPassphrase =
    clearPassphrase ? false : newPassphrase != null ? true : !!props.keyRow?.has_passphrase;

  saving.value = true;
  try {
    const savedId = await saveKey({
      id: props.keyRow?.id ?? null,
      label: form.label.trim(),
      public_key: form.publicKey.trim() || null,
      has_passphrase: hasPassphrase,
    });
    if (privateKey) {
      await saveSecret(keyPrivateKey(savedId), privateKey);
    }
    if (newPassphrase != null) {
      await saveSecret(keyPassphraseKey(savedId), newPassphrase);
    } else if (clearPassphrase) {
      await deleteSecret(keyPassphraseKey(savedId)).catch(() => undefined);
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
  <form class="absolute inset-0 flex flex-col text-fg" novalidate @submit.prevent="onSubmit">
    <!-- scrollable body -->
    <div ref="bodyRef" class="flex-1 overflow-y-auto px-9 pt-2 pb-6">
      <div class="flex flex-col gap-2.5">
        <Button variant="ghost" @click="onCancel">← Keys</Button>

        <!-- Key -->
        <section class="border border-border rounded-lg bg-surface-1">
          <header class="px-3.5 pt-2.5 pb-2 border-b border-border">
            <h3 class="m-0 text-sm font-semibold text-fg">Key</h3>
          </header>
          <div class="px-3.5 py-3 flex flex-col gap-2.5">
            <FormRow stack label="Label" html-for="ssh-key-label">
              <Input id="ssh-key-label" v-model="form.label" placeholder="e.g. Work laptop" />
              <p v-if="errors.label" class="flex items-center gap-1 text-danger text-xs mt-1">
                <AlertTriangle :size="12" /> {{ errors.label }}
              </p>
              <p v-else class="text-xs text-fg-subtle mt-1">A friendly name shown in your keys list.</p>
            </FormRow>

            <FormRow stack>
              <div class="flex items-center justify-between mb-1">
                <label for="ssh-key-private" class="text-fg-muted text-sm">Private key</label>
                <Button v-if="pkMode === 'replace'" variant="link" @click="onImportClick">
                  <span class="inline-flex items-center gap-1">
                    <Upload :size="13" /> Import from file…
                  </span>
                </Button>
              </div>
              <input ref="fileInput" type="file" class="hidden" @change="onFileChange" />

              <div
                v-if="pkMode === 'saved'"
                class="flex items-center gap-3 bg-bg border border-border rounded-md px-3 py-2.5"
              >
                <span class="grid place-items-center w-8 h-8 shrink-0 rounded-md bg-surface-2 text-accent">
                  <Lock :size="16" />
                </span>
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium text-fg">Private key saved</div>
                  <div class="text-xs text-fg-subtle mt-0.5">Stored securely.</div>
                </div>
                <Button variant="secondary" size="sm" @click="form.privateKey = ''; pkMode = 'replace'">
                  Replace
                </Button>
              </div>

              <template v-else>
                <Textarea
                  id="ssh-key-private"
                  :rows="10"
                  placeholder="Paste PEM or OpenSSH-format private key, or click &ldquo;Import from file…&rdquo;.
(Leave blank when editing to keep existing.)"
                  v-model="form.privateKey"
                />
                <p v-if="errors.privateKey" class="flex items-center gap-1 text-danger text-xs mt-1">
                  <AlertTriangle :size="12" /> {{ errors.privateKey }}
                </p>
                <div v-if="keyRow" class="mt-1.5">
                  <Button variant="link" @click="form.privateKey = ''; pkMode = 'saved'">
                    Cancel — keep saved private key
                  </Button>
                </div>
              </template>
            </FormRow>
          </div>
        </section>

        <!-- Passphrase -->
        <section class="border border-border rounded-lg bg-surface-1">
          <header class="px-3.5 pt-2.5 pb-2 border-b border-border">
            <h3 class="m-0 text-sm font-semibold text-fg">Passphrase</h3>
          </header>
          <div class="px-3.5 py-3 flex flex-col gap-2.5">
            <FormRow stack label="Passphrase">
              <div
                v-if="ppMode === 'saved'"
                class="flex items-center gap-3 bg-bg border border-border rounded-md px-3 py-2.5"
              >
                <span class="grid place-items-center w-8 h-8 shrink-0 rounded-md bg-surface-2 text-accent">
                  <Lock :size="16" />
                </span>
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium text-fg">Passphrase saved</div>
                  <div class="text-xs text-fg-subtle mt-0.5">Stored securely.</div>
                </div>
                <div class="flex gap-2">
                  <Button variant="secondary" size="sm" @click="form.passphrase = ''; ppMode = 'replace'">
                    Replace
                  </Button>
                  <Button variant="danger" size="sm" @click="form.passphrase = ''; ppMode = 'empty'">
                    Remove
                  </Button>
                </div>
              </div>

              <div v-else-if="ppMode === 'empty'" class="flex items-center gap-2 text-xs text-fg-muted py-1">
                <span>Saved passphrase will be removed when you save.</span>
                <Button variant="link" @click="ppMode = 'saved'">Undo</Button>
              </div>

              <template v-else>
                <div class="relative">
                  <Input
                    id="ssh-key-passphrase"
                    :type="showPp ? 'text' : 'password'"
                    v-model="form.passphrase"
                    :placeholder="keyRow?.has_passphrase ? 'Enter new passphrase' : 'Passphrase (optional)'"
                  />
                  <button
                    type="button"
                    class="absolute right-1.5 top-1/2 -translate-y-1/2 grid place-items-center w-7 h-7 rounded text-fg-subtle hover:text-fg-muted cursor-pointer"
                    :title="showPp ? 'Hide' : 'Show'"
                    @click="showPp = !showPp"
                  >
                    <EyeOff v-if="showPp" :size="16" />
                    <Eye v-else :size="16" />
                  </button>
                </div>
                <div v-if="keyRow?.has_passphrase" class="mt-1.5">
                  <Button variant="link" @click="form.passphrase = ''; ppMode = 'saved'">
                    Cancel — keep saved passphrase
                  </Button>
                </div>
              </template>
            </FormRow>

            <!-- Encrypted-key callout -->
            <div
              v-if="keyEncrypted === true"
              class="flex gap-2.5 bg-bg border border-border rounded-md px-3 py-2.5 text-xs text-fg-muted leading-relaxed"
            >
              <span class="shrink-0 w-1.5 h-1.5 rounded-full bg-accent mt-1.5" />
              <span>
                This key is password-protected — set the passphrase above, or leave it empty and
                you'll be asked when you connect.
              </span>
            </div>
          </div>
        </section>

        <!-- Public key -->
        <section class="border border-border rounded-lg bg-surface-1">
          <header class="px-3.5 pt-2.5 pb-2 border-b border-border">
            <h3 class="m-0 text-sm font-semibold text-fg">Public key</h3>
          </header>
          <div class="px-3.5 py-3 flex flex-col gap-2.5">
            <FormRow stack html-for="ssh-key-public">
              <Textarea
                id="ssh-key-public"
                :rows="2"
                placeholder="ssh-ed25519 AAAA… user@host"
                v-model="form.publicKey"
              />
              <p class="text-xs text-fg-subtle mt-1">
                Optional — shown in your keys list and used to display the key fingerprint.
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
      <span class="text-xs text-fg-subtle">{{ keySummary }}</span>
      <Button variant="secondary" @click="onCancel">Cancel</Button>
      <Button type="submit" :disabled="saving">{{ saving ? "Saving…" : "Save key" }}</Button>
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
