/**
 * Small transient notifications, rendered by `components/Toasts.vue`
 * (bottom-right stack). Used for events the user would otherwise miss —
 * e.g. a transfer finishing while its column isn't on screen.
 */
import { ref } from "vue";

import { toastsEnabled } from "./uiPrefs";

export interface Toast {
  id: number;
  /** Origin badge: the SSH host label the operation ran against, or "Local". */
  host: string;
  /** Bold headline, e.g. "Folder deleted". */
  title: string;
  /** Second line: what the operation applied to, e.g. the file name. */
  detail: string;
  kind: "info" | "error";
}

let nextToastId = 1;

export const toasts = ref<Toast[]>([]);

export function showToast(
  toast: Omit<Toast, "id" | "kind"> & { kind?: Toast["kind"] },
  timeoutMs = 5000,
): void {
  // Settings-pane preference (config.toml `[ui]`): disabling only silences
  // the popups — persistent transfer rows and tab-bar bells still appear.
  if (!toastsEnabled.value) return;
  const id = nextToastId++;
  toasts.value = [...toasts.value, { kind: "info", ...toast, id }];
  setTimeout(() => dismissToast(id), timeoutMs);
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}
