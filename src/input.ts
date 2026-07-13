/**
 * DOM keyboard events → `KeyEventWire` for the backend's `write_key`.
 *
 * Encoding into bytes happens on the tab thread via libghostty-vt's key
 * encoder, which reads the terminal's live modes (DECCKM, keypad mode, the
 * kitty keyboard protocol flags apps like Claude Code push). This module
 * only translates what the webview saw: the physical key (`e.code`), the
 * text the layout produced (`e.key`), and the modifier state.
 */
import type { KeyEventWire } from "./ipc";

export const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/** `e.key` values for bare modifier presses. Only worth an IPC round-trip
 *  when the kitty protocol is active (the encoder drops them otherwise). */
const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Fn",
  "FnLock",
  "Hyper",
  "Super",
  "Symbol",
]);

export function isModifierKey(e: KeyboardEvent): boolean {
  return MODIFIER_KEYS.has(e.key);
}

/** US-layout base characters for physical punctuation/digit keys. Used for
 *  the kitty protocol's "unshifted codepoint" when `e.key` already has shift
 *  (or macOS Option composition) applied and can't tell us the base. */
const CODE_BASE: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: " ",
  IntlBackslash: "\\",
  IntlYen: "¥",
};

/** True when `e.key` is a single printable grapheme (one codepoint — covers
 *  astral-plane chars whose UTF-16 length is 2). */
function printableKey(e: KeyboardEvent): string | null {
  const points = [...e.key];
  return points.length === 1 ? e.key : null;
}

function unshiftedCodepoint(e: KeyboardEvent): number {
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) {
    // Prefer the layout-produced letter (lowercased) so non-US layouts
    // report their own alphabet — except under macOS Option composition,
    // where e.key is the composed glyph (Option+O → "ø") and the base
    // key is the physical letter.
    if (!(IS_MAC && e.altKey)) {
      const k = printableKey(e);
      if (k) {
        const lower = k.toLowerCase();
        if ([...lower].length === 1) return lower.codePointAt(0)!;
      }
    }
    return code.charCodeAt(3) + 32; // "KeyA" → 'a'
  }
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  const base = CODE_BASE[code];
  if (base) return base.codePointAt(0)!;
  if (/^Numpad[0-9]$/.test(code)) return code.charCodeAt(6);
  const k = printableKey(e);
  if (k && !e.shiftKey && !(IS_MAC && e.altKey)) return k.codePointAt(0)!;
  return 0;
}

/** Composition commits (dead keys, IME) reach the PTY via `compositionend`
 *  on the hidden capture textarea — but WKWebView then re-reports the
 *  keystroke that terminated the composition through the key pipeline
 *  (xterm.js #5894), in shapes seen in the wild:
 *    - the terminating key with its plain layout value (dead-~ then a →
 *      commit "ã", then keydown key="a")
 *    - the committed text echoed as the key value (keydown key="ã")
 *    - commit and cancelling key fused ("~q" for dead-~ then q)
 *  Remember the last commit so the immediately-following keydown can be
 *  de-duplicated. */
let imeCommit: string | null = null;
let imeCommitAt = 0;

export function noteImeCommit(text: string): void {
  imeCommit = text;
  imeCommitAt = performance.now();
}

/** De-duplicate the keydown re-reported after a composition commit. `drop`
 *  means the keystroke's contribution is already inside the committed text;
 *  `utf8` overrides the wire event's text when the key value carried
 *  commit + real key fused. */
export function filterImeKeydown(e: KeyboardEvent): { drop: boolean; utf8?: string } {
  const commit = imeCommit;
  imeCommit = null; // one-shot: only the first keydown after a commit
  if (commit == null) return { drop: false };
  // Only the keydown belonging to the physical keystroke that terminated
  // the composition qualifies — it lands in the same dispatch burst as
  // compositionend. Anything later is a fresh keystroke (Chromium-based
  // webviews never re-report, so nothing may linger and eat real input).
  if (performance.now() - imeCommitAt > 50) return { drop: false };
  if (
    // Cancelled composition (Escape): the cancelling key still echoes.
    commit === "" ||
    // Committed text echoed verbatim.
    e.key === commit ||
    // Space commits a bare accent and is consumed by it (dead-~ Space → "~").
    e.key === " " ||
    // Combining press re-reported with its plain value: NFD exposes the
    // base letter inside the composed char ("ã" → "a" + U+0303).
    commit.normalize("NFD").includes(e.key)
  ) {
    return { drop: true };
  }
  // Non-combining key cancelled the dead key, fused into one value ("~q"):
  // the commit was already written — forward just the real key's character.
  if (e.key.length > commit.length && e.key.startsWith(commit)) {
    const rest = e.key.slice(commit.length);
    if ([...rest].length === 1) return { drop: false, utf8: rest };
  }
  return { drop: false };
}

/** Translate a DOM keyboard event into the wire shape `write_key` expects,
 *  or null for events the terminal should never see (IME composition,
 *  dead keys). */
export function toWireKeyEvent(
  e: KeyboardEvent,
  action: "press" | "release" | "repeat",
): KeyEventWire | null {
  if (e.isComposing || e.key === "Dead") return null;
  return {
    code: e.code,
    action,
    // The layout-produced text, pre-Ctrl transformation — exactly what the
    // encoder wants in utf8. Named keys (Enter, ArrowUp, …) pass null and
    // the encoder derives the sequence from `code`.
    utf8: printableKey(e),
    unshifted_codepoint: unshiftedCodepoint(e),
    shift: e.shiftKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    super_key: e.metaKey,
    caps_lock: e.getModifierState("CapsLock"),
    num_lock: e.getModifierState("NumLock"),
  };
}
