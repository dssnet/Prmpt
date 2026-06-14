import {
  getKey,
  listPortForwards,
  markHostHasPassword,
  markKeyHasPassphrase,
  type SshHostRow,
} from "../db";
import { inspectSshKey, type SshAuthConfig, type SshConnectConfig } from "../ipc";
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
import { openSftpOnlyHost, spawnSsh, useTabs } from "./tabs";

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

export async function connectHost(host: SshHostRow): Promise<void> {
  const { active } = useTabs();
  reflowActive(active.value);
  // SFTP-only hosts have no shell: open a files-only workspace whose browser
  // owns its SFTP consumer (no backend terminal tab). The file browser
  // resolves auth + acquires the consumer itself, so nothing to do here but
  // open the workspace.
  if (host.disable_ssh) {
    openSftpOnlyHost(host.id, host.label);
    return;
  }
  const { cellWidthPx, cellHeightPx, dpr } = getCellMetrics();
  const dims = computeDims();
  const config = await buildSshConnectConfig(host);
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
