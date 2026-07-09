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
  Grid2x2,
  FolderOpen,
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
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { listHosts, type SshHostRow } from "../db";
import { openNewWindow, openPanelWindow, terminalCwd } from "../ipc";
import { connectHost, defaultConnectMode, type ConnectMode } from "./connect";
import {
  registerCommandSource,
  type Command,
} from "./commandPalette";
import { commandShortcut } from "./keybindings";
import { requestCloseTab, requestClosePane } from "./closeGuard";
import {
  autoSplitDir,
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

async function newTerminalTab(cwd?: string): Promise<void> {
  await spawnTerminal({ ...metricArgs(), cwd });
  focusCanvas();
}

async function splitActive(dir: "h" | "v" | "auto", cwd?: string): Promise<void> {
  const a = active.value;
  if (!a || a.kind === "home") return;
  const targetSlot = a.id;
  const targetPane = inputTargetTabId() ?? a.id;
  // Resolve "auto" before the spawn reshuffles focus (mirrors App.vue).
  const resolvedDir = dir === "auto" ? autoSplitDir(targetPane) : dir;
  const newId = await spawnTerminal({ ...metricArgs(), cwd });
  dropTabIntoTarget(newId, targetSlot, targetPane, resolvedDir, false);
  focusCanvas();
}

// ---- "New Terminal…" (placement → starting-folder two-step flow) -----------

type TerminalPlacement = "tab" | "right" | "down";

/** Resolve the starting cwd for a folder choice. `undefined` = spawn default
 *  (home); `null` = the user cancelled the folder picker (abort the spawn).
 *  "same" falls back to the default when the focused pane's cwd isn't
 *  knowable (SSH panes, dead shells, Windows). */
async function resolveSpawnCwd(
  choice: "same" | "home" | "pick",
): Promise<string | undefined | null> {
  if (choice === "same") {
    const target = inputTargetTabId() ?? active.value?.id;
    if (target == null) return undefined;
    return (await terminalCwd(target).catch(() => null)) ?? undefined;
  }
  if (choice === "pick") {
    const dir = await openDialog({ directory: true, title: "Starting folder" });
    return typeof dir === "string" ? dir : null;
  }
  return undefined;
}

function terminalFolderCommands(placement: TerminalPlacement): Command[] {
  const run = (choice: "same" | "home" | "pick") =>
    void (async () => {
      const cwd = await resolveSpawnCwd(choice);
      if (cwd === null) return;
      if (placement === "tab") await newTerminalTab(cwd);
      else await splitActive(placement === "right" ? "h" : "v", cwd);
    })();
  const out: Command[] = [];
  if (isInteractive()) {
    out.push({
      id: `terminal.new.${placement}.same`,
      title: "Same Folder",
      subtitle: "The focused terminal's directory",
      icon: SquareTerminal,
      keywords: "cwd duplicate here current",
      perform: () => run("same"),
    });
  }
  out.push(
    {
      id: `terminal.new.${placement}.home`,
      title: "Home Directory",
      subtitle: "The default starting folder",
      icon: Home,
      keywords: "default",
      perform: () => run("home"),
    },
    {
      id: `terminal.new.${placement}.pick`,
      title: "Choose Folder…",
      subtitle: "Pick any directory",
      icon: FolderOpen,
      keywords: "browse other custom",
      perform: () => run("pick"),
    },
  );
  return out;
}

function terminalPlacementCommands(): Command[] {
  const out: Command[] = [];
  if (isInteractive()) {
    out.push(
      {
        id: "terminal.new.right",
        title: "Split Right",
        subtitle: "Beside the focused pane",
        icon: Columns2,
        keywords: "workspace pane vertical",
        childPlaceholder: "Starting folder…",
        children: () => terminalFolderCommands("right"),
      },
      {
        id: "terminal.new.down",
        title: "Split Down",
        subtitle: "Below the focused pane",
        icon: Rows2,
        keywords: "workspace pane horizontal",
        childPlaceholder: "Starting folder…",
        children: () => terminalFolderCommands("down"),
      },
    );
  }
  out.push({
    id: "terminal.new.tab",
    title: "New Tab",
    subtitle: "A separate terminal tab",
    icon: Plus,
    childPlaceholder: "Starting folder…",
    children: () => terminalFolderCommands("tab"),
  });
  return out;
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
      shortcut: commandShortcut("tab.new"),
      perform: () => void newTerminalTab(),
    },
    {
      id: "terminal.new",
      title: "New Terminal…",
      subtitle: "Choose placement and starting folder",
      section: "Create",
      icon: SquareTerminal,
      keywords: "shell spawn split pane folder directory cwd same here",
      childPlaceholder: "Open the terminal where?",
      children: () => terminalPlacementCommands(),
    },
    {
      id: "window.new",
      title: "New Window",
      section: "Create",
      icon: AppWindow,
      shortcut: commandShortcut("window.new"),
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
      shortcut: commandShortcut("panel.files"),
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
      shortcut: commandShortcut("panel.git"),
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
      shortcut: commandShortcut("layout.split.right"),
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
      shortcut: commandShortcut("layout.split.down"),
      when: isInteractive,
      perform: () => void splitActive("v"),
    },
    {
      id: "layout.split.auto",
      title: "New Terminal in Workspace",
      subtitle: "Split the focused pane along its longer side",
      section: "Layout",
      icon: Grid2x2,
      keywords: "auto split pane add terminal workspace",
      shortcut: commandShortcut("layout.split.auto"),
      when: isInteractive,
      perform: () => void splitActive("auto"),
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
      shortcut: commandShortcut("tab.close"),
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
