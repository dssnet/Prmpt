import { ref } from "vue";

/** Whether secrets storage is currently inaccessible — i.e. the boot-time
 *  keychain unlock failed (user dismissed the macOS prompt, the snapshot
 *  is missing, etc.). The flag is per-window and best-effort: any IPC
 *  call into the secret store updates it based on the result, so the
 *  titlebar lock indicator catches up the next time secrets are touched
 *  (boot, SSH connect, save / delete from a settings dialog). */
export const isStrongholdLocked = ref(false);

export function markStrongholdLocked() {
  isStrongholdLocked.value = true;
}

export function markStrongholdUnlocked() {
  isStrongholdLocked.value = false;
}
