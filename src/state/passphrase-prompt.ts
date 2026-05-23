import { ref } from "vue";

export interface PassphrasePromptResult {
  value: string;
  save: boolean;
}

export interface PassphrasePromptState {
  title: string;
  hint?: string;
  /** Whether to show the "Save for future connections" checkbox. */
  savable: boolean;
  resolve: (r: PassphrasePromptResult | null) => void;
}

/** Reactive ref read by `PassphrasePromptModal` in `App.vue`. */
export const passphrasePromptState = ref<PassphrasePromptState | null>(null);

/** Pops the global passphrase modal. Resolves with the user's input (and
 *  whether they want it saved), or null if they cancelled. Only one prompt
 *  is allowed at a time — a second call while one is active immediately
 *  cancels the prior prompt before showing the new one. */
export function promptPassphrase(opts: {
  title: string;
  hint?: string;
  savable?: boolean;
}): Promise<PassphrasePromptResult | null> {
  return new Promise((resolve) => {
    const prior = passphrasePromptState.value;
    if (prior) prior.resolve(null);
    passphrasePromptState.value = {
      title: opts.title,
      hint: opts.hint,
      savable: opts.savable ?? true,
      resolve: (r) => {
        passphrasePromptState.value = null;
        resolve(r);
      },
    };
  });
}
