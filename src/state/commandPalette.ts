/**
 * Command palette (Cmd/Ctrl+K) — a Raycast-style launcher built into the app.
 *
 * This module is the *runtime*: reactive open state, the registry of command
 * **sources**, and the fuzzy matcher. It deliberately knows nothing about what
 * any individual command does — sources contribute commands, the component
 * (`components/CommandPalette.vue`) renders + drives them.
 *
 * Extending the palette:
 *   - To add a few commands, register a source: `registerCommandSource(() => [
 *       { id, title, section, perform() {…} }, … ])`. The thunk runs every time
 *     the palette opens, so `when()` gates and dynamic lists (open tabs, saved
 *     hosts) stay live. Return value may be async.
 *   - A command with `children()` pushes a sub-page when activated (e.g.
 *     "Connect to SSH Host…" → a host list → connect modes), so deep,
 *     hierarchical flows compose without bespoke UI.
 *
 * The built-in commands live in `state/commands.ts`, registered on first import.
 */
import { ref, type Component } from "vue";

/** One entry in the palette. A leaf has `perform`; a branch has `children`. */
export interface Command {
  /** Stable id (used as the Vue key and for de-dup). */
  id: string;
  title: string;
  /** Dimmed secondary line (path, host address, hint…). */
  subtitle?: string;
  /** Group header shown when the query is empty. See `SECTION_ORDER`. */
  section?: string;
  /** Leading icon (a lucide-vue-next component). */
  icon?: Component;
  /** Extra search terms folded into matching but never displayed. */
  keywords?: string;
  /** Right-aligned shortcut hint, e.g. `["⌘", "T"]`. Display only. */
  shortcut?: string[];
  /** Tint as destructive (close / delete). */
  danger?: boolean;
  /** Hide the command entirely when this returns false. Evaluated at open. */
  when?: () => boolean;
  /** Leaf action. Return `false` to keep the palette open; anything else (incl.
   *  void) closes it. May be async. Ignored when `children` is set. */
  perform?: () => void | boolean | Promise<void | boolean>;
  /** Branch: activating pushes a sub-page of these commands. May be async. */
  children?: () => Command[] | Promise<Command[]>;
  /** Placeholder for the sub-page's search field (branches only). */
  childPlaceholder?: string;
}

export type CommandSource = () => Command[] | Promise<Command[]>;

/** Section render order for the empty-query grouped view. Sections not listed
 *  here sort to the end, alphabetically. Sources are free to invent new
 *  sections — add them here to control where they land. */
export const SECTION_ORDER = [
  "Create",
  "Panels",
  "Layout",
  "SSH",
  "Navigate",
  "Window",
  "Tab",
];

const sources = new Set<CommandSource>();

/** Register a command source. Returns an unregister fn (call on unmount). */
export function registerCommandSource(src: CommandSource): () => void {
  sources.add(src);
  return () => {
    sources.delete(src);
  };
}

/** Gather + flatten every source's commands for the root page, dropping those
 *  whose `when()` gate is false. A throwing source is logged and skipped so one
 *  bad contributor can't blank the palette. */
export async function collectRootCommands(): Promise<Command[]> {
  const out: Command[] = [];
  for (const src of sources) {
    try {
      const cmds = await src();
      for (const c of cmds) {
        if (!c.when || c.when()) out.push(c);
      }
    } catch (err) {
      console.error("command source failed:", err);
    }
  }
  return out;
}

// ---- open/close state ------------------------------------------------------

export const paletteOpen = ref(false);

export function openCommandPalette(): void {
  paletteOpen.value = true;
}

export function closeCommandPalette(): void {
  paletteOpen.value = false;
}

export function toggleCommandPalette(): void {
  paletteOpen.value = !paletteOpen.value;
}

// ---- fuzzy matching --------------------------------------------------------

/**
 * Subsequence fuzzy score: every char of `query` must appear in `text` in
 * order. Higher is better; returns -1 for no match. Rewards consecutive runs
 * and word-boundary starts so "ngt" ranks "New Git Tab" above an incidental
 * scatter. Empty query scores 0 (everything matches, original order kept).
 */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    let bonus = 1;
    if (lastMatch === ti - 1) bonus += 3; // contiguous with previous match
    if (ti === 0 || /[\s/\-_.:]/.test(t[ti - 1])) bonus += 4; // word start
    score += bonus;
    lastMatch = ti;
    qi++;
  }
  return qi === q.length ? score : -1;
}

/** Best fuzzy score for a command across its searchable text. Title matches
 *  outweigh subtitle/keyword matches so a title hit always wins. -1 = no match. */
export function scoreCommand(query: string, cmd: Command): number {
  if (!query) return 0;
  const title = fuzzyScore(query, cmd.title);
  const aux = Math.max(
    cmd.subtitle ? fuzzyScore(query, cmd.subtitle) : -1,
    cmd.keywords ? fuzzyScore(query, cmd.keywords) : -1,
  );
  if (title < 0 && aux < 0) return -1;
  return Math.max(title * 2, aux);
}
