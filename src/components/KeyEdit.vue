<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";

import { saveKey, type SshKeyRow } from "../db";
import { deleteSecret, keyPassphraseKey, keyPrivateKey, saveSecret } from "../secrets";
import {
  Button,
  Checkbox,
  ErrorMessage,
  FormRow,
  Input,
  Textarea,
} from "./ui";

const props = defineProps<{ keyRow: SshKeyRow | null }>();
const emit = defineEmits<{ done: []; cancel: [] }>();

const form = reactive({
  label: "",
  privateKey: "",
  passphrase: "",
  clearPassphrase: false,
  publicKey: "",
});

const errorText = ref<string | null>(null);
const saving = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

onMounted(() => {
  const k = props.keyRow;
  form.label = k?.label ?? "";
  form.privateKey = "";
  form.passphrase = "";
  form.clearPassphrase = false;
  form.publicKey = k?.public_key ?? "";
  errorText.value = null;
});

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

async function onSubmit() {
  errorText.value = null;
  if (!form.label.trim()) return (errorText.value = "Label is required");
  const privateKey = form.privateKey.trim();
  if (!props.keyRow && !privateKey) {
    errorText.value = "Private key is required";
    return;
  }

  const newPassphrase = form.passphrase ? form.passphrase : null;
  const clearPassphrase = form.clearPassphrase;
  const hasPassphrase =
    !clearPassphrase && (newPassphrase != null || !!props.keyRow?.has_passphrase);

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
  <div class="absolute inset-0 flex flex-col gap-3.5 px-9 pt-8 pb-6 overflow-y-auto text-fg">
    <Button variant="ghost" @click="emit('cancel')">← Keys</Button>
    <h2 class="m-0 text-base font-medium tracking-wide text-fg">
      {{ keyRow ? `Edit key: ${keyRow.label}` : "Add key" }}
    </h2>
    <form class="flex flex-col gap-2.5 max-w-180" novalidate @submit.prevent="onSubmit">
      <FormRow label="Label" html-for="ssh-key-label">
        <Input id="ssh-key-label" v-model="form.label" />
      </FormRow>
      <FormRow stack>
        <div class="flex items-baseline justify-between mb-1">
          <label for="ssh-key-private" class="text-fg-muted text-sm">Private key</label>
          <Button variant="link" @click="onImportClick">Import from file…</Button>
        </div>
        <input ref="fileInput" type="file" class="hidden" @change="onFileChange" />
        <Textarea
          id="ssh-key-private"
          :rows="10"
          placeholder="Paste PEM or OpenSSH-format private key, or click &ldquo;Import from file…&rdquo;.
(Leave blank when editing to keep existing.)"
          v-model="form.privateKey"
        />
      </FormRow>
      <FormRow label="Passphrase" html-for="ssh-key-passphrase">
        <Input
          id="ssh-key-passphrase"
          type="password"
          placeholder="(leave blank to keep existing or skip)"
          v-model="form.passphrase"
        />
        <Checkbox v-model="form.clearPassphrase">Clear saved passphrase</Checkbox>
      </FormRow>
      <FormRow stack label="Public key (optional)" html-for="ssh-key-public">
        <Textarea
          id="ssh-key-public"
          :rows="2"
          placeholder="ssh-ed25519 AAAA… user@host"
          v-model="form.publicKey"
        />
      </FormRow>

      <ErrorMessage v-if="errorText">{{ errorText }}</ErrorMessage>

      <div class="flex gap-2 mt-2">
        <Button type="submit" :disabled="saving">
          {{ saving ? "Saving…" : "Save" }}
        </Button>
        <Button variant="secondary" @click="emit('cancel')">Cancel</Button>
      </div>
    </form>
  </div>
</template>
