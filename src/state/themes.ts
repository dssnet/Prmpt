import type { ThemeConfig } from "../ipc";

export interface ThemePreset {
  name: string;
  theme: ThemeConfig;
}

const t = (
  background: string,
  foreground: string,
  cursor: string,
  palette: string[],
): ThemeConfig => ({ background, foreground, cursor, palette });

export const PRESETS: ThemePreset[] = [
  {
    name: "Catppuccin Mocha",
    theme: t("#1e1e2e", "#cdd6f4", "#f5e0dc", [
      "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af",
      "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
      "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af",
      "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
    ]),
  },
  {
    name: "Catppuccin Latte",
    theme: t("#eff1f5", "#4c4f69", "#dc8a78", [
      "#5c5f77", "#d20f39", "#40a02b", "#df8e1d",
      "#1e66f5", "#ea76cb", "#179299", "#acb0be",
      "#6c6f85", "#d20f39", "#40a02b", "#df8e1d",
      "#1e66f5", "#ea76cb", "#179299", "#bcc0cc",
    ]),
  },
  {
    name: "Dracula",
    theme: t("#282a36", "#f8f8f2", "#f8f8f2", [
      "#21222c", "#ff5555", "#50fa7b", "#f1fa8c",
      "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
      "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5",
      "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
    ]),
  },
  {
    name: "Solarized Dark",
    theme: t("#002b36", "#839496", "#93a1a1", [
      "#073642", "#dc322f", "#859900", "#b58900",
      "#268bd2", "#d33682", "#2aa198", "#eee8d5",
      "#586e75", "#cb4b16", "#586e75", "#657b83",
      "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
    ]),
  },
  {
    name: "Gruvbox Dark",
    theme: t("#282828", "#ebdbb2", "#ebdbb2", [
      "#282828", "#cc241d", "#98971a", "#d79921",
      "#458588", "#b16286", "#689d6a", "#a89984",
      "#928374", "#fb4934", "#b8bb26", "#fabd2f",
      "#83a598", "#d3869b", "#8ec07c", "#ebdbb2",
    ]),
  },
  {
    name: "Nord",
    theme: t("#2e3440", "#d8dee9", "#d8dee9", [
      "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b",
      "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
      "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b",
      "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4",
    ]),
  },
  {
    name: "Pitch Black",
    theme: t("#000000", "#ffffff", "#ffffff", [
      "#000000", "#cd0000", "#00cd00", "#cdcd00",
      "#3b78ff", "#cd00cd", "#00cdcd", "#e5e5e5",
      "#7f7f7f", "#ff5555", "#55ff55", "#ffff55",
      "#5c5cff", "#ff55ff", "#55ffff", "#ffffff",
    ]),
  },
];

const sameTheme = (a: ThemeConfig, b: ThemeConfig): boolean => {
  if (a.background.toLowerCase() !== b.background.toLowerCase()) return false;
  if (a.foreground.toLowerCase() !== b.foreground.toLowerCase()) return false;
  if (a.cursor.toLowerCase() !== b.cursor.toLowerCase()) return false;
  if (a.palette.length !== b.palette.length) return false;
  for (let i = 0; i < a.palette.length; i++) {
    if (a.palette[i].toLowerCase() !== b.palette[i].toLowerCase()) return false;
  }
  return true;
};

export function findPresetMatch(theme: ThemeConfig): string | null {
  for (const p of PRESETS) {
    if (sameTheme(p.theme, theme)) return p.name;
  }
  return null;
}
