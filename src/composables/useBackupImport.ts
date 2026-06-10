/**
 * Backup-import state machine, shared by Settings → Backup and the
 * first-boot welcome flow.
 *
 * Importing is destructive and staged: `import_backup` only unpacks the
 * archive into a staging dir; the swap happens on next startup, which is
 * why the success path relaunches the app. The flow is:
 *
 *   pickFile() → .prmpt open dialog → showConfirm (destructive warning)
 *   confirm()  → runImport(no passphrase)
 *                ├─ ok → beforeRelaunch?() → relaunch()
 *                ├─ encrypted → showPassPrompt → submitPassphrase() retries
 *                └─ other error → onError?(msg) and reset
 */
import { ref } from "vue";

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";

import { BACKUP_ENCRYPTED_NEEDS_PASSPHRASE, importBackup } from "../ipc";

export function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

export function useBackupImport(opts?: {
  /** Runs after import_backup succeeds, BEFORE relaunch(). localStorage is
   *  not part of the backup, so flags written here survive the data swap. */
  beforeRelaunch?: () => void;
  /** Non-passphrase failures (bad file, IO error, cancelled dialog error). */
  onError?: (msg: string) => void;
}) {
  const busy = ref(false);
  const showConfirm = ref(false);
  const showPassPrompt = ref(false);
  const passphrase = ref("");
  const passError = ref<string | null>(null);
  const pendingPath = ref<string | null>(null);

  async function pickFile() {
    let path: string | string[] | null;
    try {
      path = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "Prmpt backup", extensions: ["prmpt"] }],
      });
    } catch (e) {
      opts?.onError?.(errText(e));
      return;
    }
    if (typeof path !== "string") return; // cancelled
    pendingPath.value = path;
    showConfirm.value = true;
  }

  function cancel() {
    showConfirm.value = false;
    showPassPrompt.value = false;
    pendingPath.value = null;
    passphrase.value = "";
    passError.value = null;
  }

  // First attempt: no passphrase. If the file turns out to be encrypted the
  // backend asks for one (sentinel error) and we surface the passphrase modal.
  async function confirm() {
    showConfirm.value = false;
    await runImport(undefined);
  }

  async function submitPassphrase() {
    if (!passphrase.value) return;
    passError.value = null;
    await runImport(passphrase.value);
  }

  async function runImport(pass: string | undefined) {
    const path = pendingPath.value;
    if (!path) return;
    busy.value = true;
    try {
      await importBackup(path, pass);
      // Staged successfully — relaunch so the swap is applied before the DB
      // is reopened. The new process picks up the imported data on boot.
      opts?.beforeRelaunch?.();
      await relaunch();
    } catch (e) {
      const msg = errText(e);
      if (msg.includes(BACKUP_ENCRYPTED_NEEDS_PASSPHRASE)) {
        // Encrypted backup, no/blank passphrase yet — prompt for one.
        showPassPrompt.value = true;
      } else if (showPassPrompt.value) {
        // We're already prompting; a failure here is almost always a bad
        // passphrase. Keep the modal open and show why.
        passError.value = msg;
      } else {
        cancel();
        opts?.onError?.(msg);
      }
    } finally {
      busy.value = false;
    }
  }

  return {
    busy,
    showConfirm,
    showPassPrompt,
    passphrase,
    passError,
    pickFile,
    confirm,
    cancel,
    submitPassphrase,
  };
}
