/**
 * Built-in command-palette commands. Registered once on first import (see the
 * `import "./commands"` side-effect in `components/CommandPalette.vue`).
 *
 * Everything here is wired straight to existing state/ipc helpers — the palette
 * is a *second* front door onto actions the tab bar, pills and keyboard
 * shortcuts already expose, so behaviour stays identical no matter how it's
 * triggered. New first-party commands go in this file; third-party / future
 * features can call `registerCommandSource` from anywhere instead.
 */
import {
  AppWindow,
  ArrowRightLeft,
  Columns2,
  FolderTree,
  GitBranch,
  Home,
  PanelRight,
  Plus,
  Rows2,
  Server,
  SquareTerminal,
  X,
} from "lucide-vue-next";

import { listHosts, type SshHostRow } from "../db";
import { openNewWindow, openPanelWindow } from "../ipc";
import { connectHost, defaultConnectMode, type ConnectMode } from "./connect";
import {
  registerCommandSource,
  type Command,
} from "./commandPalette";
import { requestCloseTab, requestClosePane } from "./closeGuard";
import {
  computeDims,
  focusCanvas,
  getCellMetrics,
  inputTargetTabId,
} from "./terminal";
import {
  dropTabIntoTarget,
  HOME_TAB_ID,
  openPanelOnActive,
  openPanelTab,
  setActive,
  spawnTerminal,
  useTabs,
} from "./tabs";

const { tabs, active } = useTabs();

// ---- shared actions (mirror App.vue's keyboard-shortcut handlers) ----------

function metricArgs() {
  const { cellWidthPx, cellHeightPx, dpr } = getCellMetrics();
  const dims = computeDims();
  return {
    cols: dims.cols,
    rows: dims.rows,
    cellWidthPx: Math.round(cellWidthPx * dpr),
    cellHeightPx: Math.round(cellHeightPx * dpr),
  };
}

async function newTerminalTab(): Promise<void> {
  await spawnTerminal(metricArgs());
  focusCanvas();
}

async function splitActive(dir: "h" | "v"): Promise<void> {
  const a = active.value;
  if (!a || a.kind === "home") return;
  const targetSlot = a.id;
  const targetPane = inputTargetTabId() ?? a.id;
  const newId = await spawnTerminal(metricArgs());
  dropTabIntoTarget(newId, targetSlot, targetPane, dir, false);
  focusCanvas();
}

function isInteractive(): boolean {
  return !!active.value && active.value.kind !== "home";
}

function isWorkspace(): boolean {
  return active.value?.kind === "workspace";
}

// ---- SSH connect (host list → connect-mode sub-pages) ----------------------

const MODES: { mode: ConnectMode; title: string; subtitle: string }[] = [
  { mode: "both", title: "Shell + Files", subtitle: "Terminal with an SFTP file browser" },
  { mode: "shell", title: "Shell only", subtitle: "Terminal, no file browser" },
  { mode: "sftp", title: "Files only", subtitle: "SFTP browser, no shell" },
];

function connectModeCommands(host: SshHostRow): Command[] {
  const fallback = defaultConnectMode(host);
  return MODES.map((m) => ({
    id: `ssh.host.${host.id}.${m.mode}`,
    title: m.mode === fallback ? `${m.title}  (default)` : m.title,
    subtitle: m.subtitle,
    icon: Server,
    perform: () => void connectHost(host, m.mode),
  }));
}

function sshHostCommands(hosts: SshHostRow[]): Command[] {
  return hosts.map((h) => ({
    id: `ssh.host.${h.id}`,
    title: h.label,
    subtitle: `${h.username}@${h.hostname}:${h.port}`,
    icon: Server,
    keywords: `${h.hostname} ${h.username} ssh connect`,
    childPlaceholder: `Connect to ${h.label}…`,
    children: () => connectModeCommands(h),
  }));
}

// ---- switch-to-tab (live tab list) -----------------------------------------

function switchTabCommands(): Command[] {
  return tabs.value.map((t) => ({
    id: `tab.switch.${t.id}`,
    title: t.title || (t.kind === "home" ? "Home" : `Tab ${t.id}`),
    subtitle: t.id === active.value?.id ? "Current tab" : undefined,
    icon: t.kind === "home" ? Home : SquareTerminal,
    perform: () => setActive(t.id),
  }));
}

// ---- the root command set --------------------------------------------------

function rootCommands(): Command[] {
  return [
    // Create
    {
      id: "tab.new",
      title: "New Terminal Tab",
      section: "Create",
      icon: Plus,
      keywords: "shell spawn",
      shortcut: ["⌘", "T"],
      perform: () => void newTerminalTab(),
    },
    {
      id: "window.new",
      title: "New Window",
      section: "Create",
      icon: AppWindow,
      shortcut: ["⌘", "N"],
      perform: () => void openNewWindow(),
    },

    // Panels — in the current workspace
    {
      id: "panel.files",
      title: "Open File Browser",
      subtitle: "Split a files panel into the current workspace",
      section: "Panels",
      icon: FolderTree,
      keywords: "sftp folder directory explorer",
      shortcut: ["⌘", "B"],
      when: isInteractive,
      perform: () => void openPanelOnActive("files"),
    },
    {
      id: "panel.git",
      title: "Open Git Panel",
      subtitle: "Split a git panel into the current workspace",
      section: "Panels",
      icon: GitBranch,
      keywords: "status diff commit branch",
      shortcut: ["⌘", "G"],
      when: isWorkspace,
      perform: () => void openPanelOnActive("git"),
    },
    // Panels — as their own tab
    {
      id: "panel.files.tab",
      title: "Open File Browser in New Tab",
      section: "Panels",
      icon: FolderTree,
      keywords: "sftp folder directory",
      perform: () => openPanelTab("files"),
    },
    {
      id: "panel.git.tab",
      title: "Open Git Panel in New Tab",
      section: "Panels",
      icon: GitBranch,
      perform: () => openPanelTab("git"),
    },
    // Panels — in their own window
    {
      id: "panel.files.window",
      title: "Open File Browser in New Window",
      section: "Panels",
      icon: PanelRight,
      perform: () => void openPanelWindow("files"),
    },
    {
      id: "panel.git.window",
      title: "Open Git Panel in New Window",
      section: "Panels",
      icon: PanelRight,
      perform: () => void openPanelWindow("git"),
    },

    // Layout
    {
      id: "layout.split.right",
      title: "Split Right",
      subtitle: "New terminal beside the focused pane",
      section: "Layout",
      icon: Columns2,
      keywords: "vertical divide pane",
      shortcut: ["⌘", "D"],
      when: isInteractive,
      perform: () => void splitActive("h"),
    },
    {
      id: "layout.split.down",
      title: "Split Down",
      subtitle: "New terminal below the focused pane",
      section: "Layout",
      icon: Rows2,
      keywords: "horizontal divide pane",
      shortcut: ["⌘", "⇧", "D"],
      when: isInteractive,
      perform: () => void splitActive("v"),
    },

    // SSH
    {
      id: "ssh.connect",
      title: "Connect to SSH Host…",
      section: "SSH",
      icon: Server,
      keywords: "remote server login",
      childPlaceholder: "Search saved hosts…",
      children: async () => {
        const hosts = await listHosts();
        if (hosts.length === 0) {
          return [
            {
              id: "ssh.none",
              title: "No saved hosts",
              subtitle: "Add one from the Home tab",
              icon: Server,
              perform: () => setActive(HOME_TAB_ID),
            },
          ];
        }
        return sshHostCommands(hosts);
      },
    },

    // Navigate
    {
      id: "nav.switch",
      title: "Switch to Tab…",
      section: "Navigate",
      icon: ArrowRightLeft,
      keywords: "go jump select",
      childPlaceholder: "Search open tabs…",
      children: () => switchTabCommands(),
    },
    {
      id: "nav.home",
      title: "Go to Home / Host Manager",
      section: "Navigate",
      icon: Home,
      keywords: "settings hosts keys start",
      perform: () => setActive(HOME_TAB_ID),
    },

    // Tab — destructive, kept last
    {
      id: "tab.close.pane",
      title: "Close Focused Pane",
      section: "Tab",
      icon: X,
      danger: true,
      when: () => {
        if (!isWorkspace()) return false;
        return inputTargetTabId() != null;
      },
      perform: () => {
        const target = inputTargetTabId();
        if (target != null) void requestClosePane(target);
      },
    },
    {
      id: "tab.close",
      title: "Close Tab",
      section: "Tab",
      icon: X,
      danger: true,
      shortcut: ["⌘", "W"],
      when: isInteractive,
      perform: () => {
        const a = active.value;
        if (a) void requestCloseTab(a);
      },
    },
  ];
}

let registered = false;

/** Register the first-party commands. Idempotent — guarded so Vite HMR
 *  re-importing this module doesn't stack a second copy. */
export function registerBuiltinCommands(): void {
  if (registered) return;
  registered = true;
  registerCommandSource(rootCommands);
}

registerBuiltinCommands();
