/**
 * App-level keyboard shortcuts: the single source of truth for every bindable
 * action, its default chord, and any user override.
 *
 * This module owns the *data and matching* — what each shortcut is and whether
 * a given keyboard event fires it. It deliberately knows nothing about what an
 * action *does*: `App.vue` maps each action id to a handler and drives the
 * keydown loop, the command palette reads chords for its hints, and
 * `Settings.vue` renders + rebinds them. Overrides live in config.toml's
 * `[keybindings]` table (loaded at startup, written back via `set_keybindings`)
 * so they ride backups / cross-install sync like the rest of the config.
 *
 * Only *deviations from the default* are stored, so the shipped defaults can
 * evolve without rewriting every user's file.
 */
import { reactive } from "vue";

import { setKeybindings } from "../ipc";

// macOS uses Cmd (metaKey) as the app modifier; Linux/Windows terminals use
// Ctrl+Shift so plain Ctrl stays free for shell control codes (Ctrl+C =
// SIGINT, Ctrl+D = EOF, …). Matches GNOME Terminal / Konsole / Windows
// Terminal conventions.
export const IS_MAC =
  /Mac|iPhone|iPod|iPad/.test(navigator.platform) ||
  navigator.userAgent.includes("Mac OS X");
export const IS_WIN = !IS_MAC && /Win/i.test(navigator.platform);

/** True when the platform's primary app-shortcut chord is held. */
export function isPrimaryMod(e: KeyboardEvent): boolean {
  return IS_MAC
    ? e.metaKey && !e.ctrlKey
    : e.ctrlKey && e.shiftKey && !e.metaKey;
}

/**
 * Layout/Shift-stable key name: physical letter/digit via `code` (so
 * Ctrl+Shift+C still reads as "c" and Ctrl+Shift+1 as "1"), otherwise the
 * logical key ("ArrowUp", "Home", …).
 */
export function canonicalKey(e: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (e.key.length === 1) return e.key.toLowerCase();
  return e.key;
}

/**
 * A normalized shortcut. `primary` is the abstract app modifier (⌘ on macOS,
 * Ctrl+Shift on Win/Linux). `shift` is an *extra* Shift, only distinguishable
 * on macOS — on Win/Linux the primary chord already folds it in, so it's
 * dropped there during capture and ignored during matching.
 */
export interface Chord {
  primary: boolean;
  shift: boolean;
  alt: boolean;
  /** Canonical key: lowercase letter/digit, or a named key ("ArrowUp"). */
  key: string;
}

/** Build the event's chord, normalized for storage. */
export function chordFromEvent(e: KeyboardEvent): Chord {
  const primary = isPrimaryMod(e);
  return {
    primary,
    // Win/Linux primary already implies Shift — don't record it twice.
    shift: primary && !IS_MAC ? false : e.shiftKey,
    alt: e.altKey,
    key: canonicalKey(e),
  };
}

/** Whether `c` is the chord the user just pressed. */
export function chordMatchesEvent(c: Chord, e: KeyboardEvent): boolean {
  if (canonicalKey(e) !== c.key) return false;
  const primary = isPrimaryMod(e);
  if (primary !== c.primary) return false;
  if (c.primary) {
    // Win/Linux: Shift is part of the primary chord, not separately checkable.
    if (IS_MAC && e.shiftKey !== c.shift) return false;
  } else {
    if (e.shiftKey !== c.shift) return false;
    if (e.metaKey || e.ctrlKey) return false;
  }
  return e.altKey === c.alt;
}

/** Serialize to the compact form stored in config (`Mod+Shift+D`, `Shift+PageUp`). */
export function formatChord(c: Chord): string {
  const parts: string[] = [];
  if (c.primary) parts.push("Mod");
  if (c.shift) parts.push("Shift");
  if (c.alt) parts.push("Alt");
  parts.push(c.key);
  return parts.join("+");
}

/** Parse the stored form back into a chord (null on malformed input). */
export function parseChord(s: string): Chord | null {
  const parts = s.split("+");
  const key = parts.pop();
  if (!key) return null;
  return {
    primary: parts.includes("Mod"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
    key,
  };
}

function keyLabel(key: string): string {
  switch (key) {
    case "ArrowUp": return "↑";
    case "ArrowDown": return "↓";
    case "ArrowLeft": return "←";
    case "ArrowRight": return "→";
    case "PageUp": return "PgUp";
    case "PageDown": return "PgDn";
    case "Enter": return "↵";
    case "Escape": return "Esc";
    case " ": return "Space";
    default: return key.length === 1 ? key.toUpperCase() : key;
  }
}

/** Display tokens for a chord, adapted to the platform (`["⌘","T"]`). */
export function chordTokens(c: Chord): string[] {
  const t: string[] = [];
  if (c.primary) {
    if (IS_MAC) t.push("⌘");
    else t.push("Ctrl", "Shift");
  }
  if (c.shift && !(c.primary && !IS_MAC)) t.push(IS_MAC ? "⇧" : "Shift");
  if (c.alt) t.push(IS_MAC ? "⌥" : "Alt");
  t.push(keyLabel(c.key));
  return t;
}

/** A modifier-only chord (so binding it won't shadow ordinary terminal input). */
export function isBindableChord(c: Chord): boolean {
  if (!c.key) return false;
  // A bare Shift+letter would just type an uppercase character — require a
  // primary/alt modifier, or Shift with a named (non-printable) key.
  return c.primary || c.alt || (c.shift && c.key.length > 1);
}

// ---- the action registry ---------------------------------------------------

export type KeybindSection =
  | "General"
  | "Tabs & Windows"
  | "Layout"
  | "Panels"
  | "Scrolling"
  | "Editing";

export const KEYBIND_SECTIONS: KeybindSection[] = [
  "General",
  "Tabs & Windows",
  "Layout",
  "Panels",
  "Scrolling",
  "Editing",
];

export interface ActionMeta {
  /** Stable id — also the key in the stored override table, and (for several)
   *  the matching command-palette command id. */
  id: string;
  label: string;
  section: KeybindSection;
  hint?: string;
  default: Chord;
  /** false → shown for discoverability but not user-rebindable (tied to the OS
   *  menu, or a numeric family rather than one chord). Defaults to editable. */
  editable?: boolean;
  /** Informational row: not matched in the keydown loop (handled specially),
   *  display only. */
  info?: boolean;
  /** For info rows: token shown in place of the representative key (e.g. "1–9"). */
  displaySuffix?: string;
}

const mod = (key: string, opts: { shift?: boolean; alt?: boolean } = {}): Chord => ({
  primary: true,
  shift: !!opts.shift,
  alt: !!opts.alt,
  key,
});

const shiftOnly = (key: string): Chord => ({
  primary: false,
  shift: true,
  alt: false,
  key,
});

export const ACTIONS: ActionMeta[] = [
  { id: "palette.open", label: "Open Command Palette", section: "General", default: mod("k") },

  { id: "tab.new", label: "New Terminal Tab", section: "Tabs & Windows", default: mod("t") },
  { id: "window.new", label: "New Window", section: "Tabs & Windows", default: mod("n") },
  { id: "tab.close", label: "Close Tab", section: "Tabs & Windows", default: mod("w") },
  {
    id: "nav.switchNumber",
    label: "Switch to Tab 1–9",
    section: "Tabs & Windows",
    default: mod("1"),
    editable: false,
    info: true,
    displaySuffix: "1–9",
  },

  {
    id: "layout.split.right",
    label: "Split Right",
    section: "Layout",
    hint: "New terminal beside the focused pane",
    default: mod("d"),
  },
  {
    id: "layout.split.down",
    label: "Split Down",
    section: "Layout",
    hint: "New terminal below the focused pane",
    default: mod("d", { shift: true }),
  },
  {
    id: "layout.split.auto",
    label: "New Terminal in Workspace",
    section: "Layout",
    hint: "Split the focused pane along its longer side",
    default: mod("Enter"),
  },

  { id: "panel.files", label: "Open File Browser", section: "Panels", default: mod("b") },
  { id: "panel.git", label: "Open Git Panel", section: "Panels", default: mod("g") },

  { id: "scroll.lineUp", label: "Scroll Up", section: "Scrolling", default: mod("ArrowUp") },
  { id: "scroll.lineDown", label: "Scroll Down", section: "Scrolling", default: mod("ArrowDown") },
  { id: "scroll.top", label: "Scroll to Top", section: "Scrolling", default: mod("Home") },
  { id: "scroll.bottom", label: "Scroll to Bottom", section: "Scrolling", default: mod("End") },
  { id: "scroll.pageUp", label: "Scroll Page Up", section: "Scrolling", default: shiftOnly("PageUp") },
  { id: "scroll.pageDown", label: "Scroll Page Down", section: "Scrolling", default: shiftOnly("PageDown") },

  {
    id: "edit.copy",
    label: "Copy",
    section: "Editing",
    hint: "Copy the selection. Also on the Edit menu.",
    default: mod("c"),
    editable: false,
  },
  {
    id: "edit.paste",
    label: "Paste",
    section: "Editing",
    hint: "Paste the clipboard. Also on the Edit menu.",
    default: mod("v"),
    editable: false,
  },
  {
    id: "edit.selectAll",
    label: "Select All",
    section: "Editing",
    hint: "Select the whole screen. Also on the Edit menu.",
    default: mod("a"),
    editable: false,
  },
];

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

// ---- override store + persistence ------------------------------------------

/** id → serialized chord, for actions the user has rebound. Reactive so the
 *  palette hints and settings rows update the moment a binding changes. */
const overrides = reactive<Record<string, string>>({});

/** Seed from the loaded config (called once at startup, before mount). */
export function initKeybindings(map: Record<string, string> | undefined): void {
  for (const k of Object.keys(overrides)) delete overrides[k];
  for (const [id, s] of Object.entries(map ?? {})) {
    if (BY_ID.has(id)) overrides[id] = s;
  }
}

function persist(): void {
  void setKeybindings({ ...overrides });
}

/** The live chord for an action — its override, or the shipped default. */
export function bindingFor(id: string): Chord {
  const o = overrides[id];
  if (o) {
    const c = parseChord(o);
    if (c) return c;
  }
  const meta = BY_ID.get(id);
  return meta ? meta.default : { primary: false, shift: false, alt: false, key: "" };
}

/** Whether the user has changed this action from its default. */
export function isCustomized(id: string): boolean {
  return overrides[id] != null;
}

/** Display tokens for an action's current binding (with info-row suffixes). */
export function actionTokens(a: ActionMeta): string[] {
  const t = chordTokens(bindingFor(a.id));
  if (a.info && a.displaySuffix) t[t.length - 1] = a.displaySuffix;
  return t;
}

/** Display tokens for a command-palette command id, or undefined if unbound. */
export function commandShortcut(id: string): string[] | undefined {
  return BY_ID.has(id) ? actionTokens(BY_ID.get(id)!) : undefined;
}

/** Another editable action already bound to `chord` (excluding `id`), or null. */
export function conflictFor(id: string, chord: Chord): ActionMeta | null {
  const s = formatChord(chord);
  for (const a of ACTIONS) {
    if (a.id === id || a.info) continue;
    if (formatChord(bindingFor(a.id)) === s) return a;
  }
  return null;
}

export function setBinding(id: string, chord: Chord): void {
  const meta = BY_ID.get(id);
  const s = formatChord(chord);
  if (meta && formatChord(meta.default) === s) delete overrides[id];
  else overrides[id] = s;
  persist();
}

export function resetBinding(id: string): void {
  if (overrides[id] != null) {
    delete overrides[id];
    persist();
  }
}
