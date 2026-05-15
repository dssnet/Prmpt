import { ref } from "vue";

import { setTheme, type ThemeConfig } from "../ipc";

const theme = ref<ThemeConfig>({
  background: "#0c0e14",
  foreground: "#bfbdb6",
  cursor: "#ffb454",
  palette: Array(16).fill("#000000"),
});

export function useTheme() {
  return { theme };
}

export function initTheme(initial: ThemeConfig): void {
  theme.value = initial;
  applyThemeVars(initial);
}

function parseHex(hex: string): [number, number, number] {
  let h = hex.trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return [Number.isFinite(r) ? r : 0, Number.isFinite(g) ? g : 0, Number.isFinite(b) ? b : 0];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function applyThemeVars(t: ThemeConfig): void {
  const root = document.documentElement;
  root.style.setProperty("--bg", t.background);
  root.style.setProperty("--fg", t.foreground);
  // palette[4] is ANSI blue across every preset — a good accent for selected
  // / active UI affordances. Fall back to fg if missing.
  root.style.setProperty("--accent", t.palette[4] ?? t.foreground);
  root.style.setProperty(
    "color-scheme",
    relativeLuminance(t.background) > 0.5 ? "light" : "dark",
  );
  document.body.style.background = "";
  document.body.style.color = "";
}

/** Called when the user picks a preset or edits the custom theme. The
 *  TerminalView watches `theme` to push the new colors into the renderer
 *  and force every open tab to re-emit a snapshot. */
export async function applyTheme(next: ThemeConfig): Promise<void> {
  theme.value = next;
  applyThemeVars(next);
  await setTheme(next);
}
