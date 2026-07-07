import {
  getHost,
  getKey,
  listPortForwards,
  markHostHasPassword,
  markKeyHasPassphrase,
  type SshHostRow,
} from "../db";
import {
  closeTab,
  connectSshHost,
  inspectSshKey,
  spawnTab,
  type SshAuthConfig,
  type SshConnectConfig,
} from "../ipc";
import {
  hostPasswordKey,
  keyPassphraseKey,
  keyPrivateKey,
  loadSecret,
  saveSecret,
} from "../secrets";
import { promptPassphrase } from "./passphrase-prompt";
import {
  computeDims,
  focusCanvas,
  getCellMetrics,
  reflowActive,
} from "./terminal";
import { addRestoredWorkspace, openSftpOnlyHost, spawnSsh, useTabs } from "./tabs";
import {
  collectLeaves,
  collectTerminalLeaves,
  makeLeaf,
  makeSplit,
  type LeafNode,
  type WorkspaceNode,
} from "./workspace";
import { allocPanelLeafId, panelTitle } from "./panels";
import { getSavedWorkspace, type SavedNode } from "./savedWorkspaces";
import { showToast } from "./toasts";

export async function resolveAuth(host: SshHostRow): Promise<SshAuthConfig> {
  if (host.auth_method === "agent") return { kind: "agent" };

  if (host.auth_method === "password") {
    let pw = await loadSecret(hostPasswordKey(host.id));
    if (pw == null) {
      const result = await promptPassphrase({
        title: `Enter password for ${host.label}`,
        hint: `${host.username}@${host.hostname}`,
        savable: true,
      });
      if (result == null) throw new Error("Connection cancelled.");
      pw = result.value;
      if (result.save) {
        await saveSecret(hostPasswordKey(host.id), pw);
        await markHostHasPassword(host.id, true);
      }
    }
    return { kind: "password", password: pw };
  }

  if (host.key_id == null) {
    throw new Error("Host configured for key auth but no key is linked.");
  }
  const privateKey = await loadSecret(keyPrivateKey(host.key_id));
  if (privateKey == null) {
    throw new Error("Private key missing from Stronghold — edit the key and re-paste.");
  }
  let passphrase = await loadSecret(keyPassphraseKey(host.key_id));
  if (passphrase == null) {
    // No saved passphrase. The key might be unencrypted (then we can connect
    // as-is) or encrypted (then we need to ask the user). Probe via the
    // backend so we use the actual russh parser rather than a fragile
    // text/base64 check.
    const info = await inspectSshKey(privateKey);
    if (info.encrypted) {
      const keyId = host.key_id;
      const keyRow = await getKey(keyId);
      const keyLabel = keyRow?.label ?? `#${keyId}`;
      const result = await promptPassphrase({
        title: `Enter passphrase for key "${keyLabel}"`,
        hint: "This SSH key is password-protected.",
        savable: true,
      });
      if (result == null) throw new Error("Connection cancelled.");
      passphrase = result.value;
      if (result.save) {
        await saveSecret(keyPassphraseKey(keyId), passphrase);
        await markKeyHasPassphrase(keyId, true);
      }
    }
  }
  return { kind: "key", private_key: privateKey, passphrase };
}

/** Assemble the full `SshConnectConfig` (auth + port forwards) for a host.
 *  Used by both the shell-tab connect path and the file browser's SFTP
 *  consumer acquire, so a second consumer never re-prompts. */
export async function buildSshConnectConfig(host: SshHostRow): Promise<SshConnectConfig> {
  const auth = await resolveAuth(host);
  const fwds = await listPortForwards(host.id);
  return {
    host_id: host.id,
    label: host.label,
    hostname: host.hostname,
    port: host.port,
    username: host.username,
    auth,
    stored_fingerprint: host.host_fp_sha256,
    disable_sftp: host.disable_sftp,
    disable_ssh: host.disable_ssh,
    forwards: fwds
      .filter((f) => f.enabled)
      .map((f) => ({
        id: f.id,
        kind: f.kind,
        bind_host: f.bind_host,
        bind_port: f.bind_port,
        target_host: f.target_host,
        target_port: f.target_port,
      })),
  };
}

/** How to connect to a host. `"both"` = shell terminal + SFTP file browser,
 *  `"shell"` = terminal only, `"sftp"` = files-only workspace (no shell). */
export type ConnectMode = "both" | "shell" | "sftp";

/** The host's stored default connect mode, derived from its disable flags. */
export function defaultConnectMode(host: SshHostRow): ConnectMode {
  if (host.disable_ssh) return "sftp";
  if (host.disable_sftp) return "shell";
  return "both";
}

export async function connectHost(host: SshHostRow, mode?: ConnectMode): Promise<void> {
  const { active } = useTabs();
  reflowActive(active.value);
  // An explicit mode (from the connect dropdown) overrides the host's stored
  // default; otherwise fall back to whatever the host config implies.
  const effective = mode ?? defaultConnectMode(host);
  // SFTP-only: open a files-only workspace whose browser owns its SFTP consumer
  // (no backend terminal tab). The file browser resolves auth + acquires the
  // consumer itself, so nothing to do here but open the workspace.
  if (effective === "sftp") {
    openSftpOnlyHost(host.id, host.label);
    return;
  }
  const { cellWidthPx, cellHeightPx, dpr } = getCellMetrics();
  const dims = computeDims();
  const config = await buildSshConnectConfig(host);
  // Force the file-panel availability to match the chosen mode, independent of
  // the host's stored default (shell → no SFTP panel, both → SFTP panel).
  config.disable_sftp = effective === "shell";
  config.disable_ssh = false;
  await spawnSsh({
    hostId: host.id,
    hostLabel: host.label,
    cols: dims.cols,
    rows: dims.rows,
    cellWidthPx: Math.round(cellWidthPx * dpr),
    cellHeightPx: Math.round(cellHeightPx * dpr),
    config,
  });
  focusCanvas();
}

// ---- Saved workspaces ------------------------------------------------------
// Rehydration of a stored tiling tree (serialization + DB live in
// state/savedWorkspaces.ts). Each leaf is respawned to a fresh backend:
// terminals via spawn_tab, ssh panes by reconnecting the host (which may
// prompt for a password/passphrase), panels as frontend-only leaves. The
// rebuilt tree is handed to `addRestoredWorkspace` as one new tab.

interface RestoreMetrics {
  cols: number;
  rows: number;
  cellWidthPx: number;
  cellHeightPx: number;
}

async function buildLiveNode(
  node: SavedNode,
  metrics: RestoreMetrics,
  spawned: number[],
): Promise<WorkspaceNode> {
  if (node.kind === "split") {
    const a = await buildLiveNode(node.a, metrics, spawned);
    const b = await buildLiveNode(node.b, metrics, spawned);
    return makeSplit(node.dir, a, b, node.ratio);
  }
  const origin = node.origin;
  // Frontend-only panel pane — no backend, just a fresh negative leaf id.
  if (origin.kind === "panel" && origin.panel) {
    return makeLeaf(allocPanelLeafId(), {
      kind: "panel",
      title: origin.title || panelTitle(origin.panel),
      panel: origin.panel,
    });
  }
  // SSH shell pane — reconnect the host by id (forcing shell + SFTP on so any
  // saved files panel on it works). A deleted host degrades to a local shell.
  if (origin.kind === "ssh" && origin.hostId != null) {
    const host = await getHost(origin.hostId);
    if (host) {
      const config = await buildSshConnectConfig(host);
      config.disable_sftp = false;
      config.disable_ssh = false;
      const id = await connectSshHost({ config, ...metrics });
      spawned.push(id);
      return makeLeaf(id, origin);
    }
    showToast(
      {
        host: origin.hostLabel ?? "SSH",
        title: "Host no longer exists",
        detail: `"${origin.hostLabel ?? origin.title}" was removed — opened a local shell in its place.`,
        kind: "error",
      },
      6000,
    );
    // fall through to a local terminal placeholder
  }
  // Local terminal pane (or an ssh leaf whose host is gone). Reopen in the
  // folder it was saved in when we have one (the backend ignores a stale path).
  const id = await spawnTab({ ...metrics, cwd: node.cwd });
  spawned.push(id);
  return makeLeaf(id, { kind: "terminal", title: origin.title || "Terminal" });
}

/** Reopen a saved workspace as a new tab, respawning every pane. */
export async function loadSavedWorkspace(id: number): Promise<void> {
  const saved = await getSavedWorkspace(id);
  if (!saved) {
    showToast(
      {
        host: "Workspace",
        title: "Could not load workspace",
        detail: "The saved layout is missing or unreadable.",
        kind: "error",
      },
      5000,
    );
    return;
  }
  const { active } = useTabs();
  reflowActive(active.value);
  const { cellWidthPx, cellHeightPx, dpr } = getCellMetrics();
  const dims = computeDims();
  const metrics: RestoreMetrics = {
    cols: dims.cols,
    rows: dims.rows,
    cellWidthPx: Math.round(cellWidthPx * dpr),
    cellHeightPx: Math.round(cellHeightPx * dpr),
  };
  const spawned: number[] = [];
  let root: WorkspaceNode;
  try {
    root = await buildLiveNode(saved.root, metrics, spawned);
  } catch (err) {
    // A pane failed (e.g. the user cancelled an ssh password prompt). Tear down
    // whatever backends we already spawned so we don't leak orphaned PTYs.
    console.error("workspace restore failed:", err);
    for (const tid of spawned) void closeTab(tid).catch(() => undefined);
    showToast(
      {
        host: "Workspace",
        title: "Could not open workspace",
        detail: err instanceof Error ? err.message : "One of its connections failed.",
        kind: "error",
      },
      6000,
    );
    return;
  }
  const focus: LeafNode | undefined =
    collectTerminalLeaves(root)[0] ?? collectLeaves(root)[0];
  if (!focus) return; // a tree always has a leaf; belt-and-suspenders
  addRestoredWorkspace(saved.label, root, focus.tabId);
  focusCanvas();
}
