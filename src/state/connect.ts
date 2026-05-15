import { listPortForwards, type SshHostRow } from "../db";
import {
  hostPasswordKey,
  keyPassphraseKey,
  keyPrivateKey,
  loadSecret,
} from "../secrets";
import { type SshAuthConfig } from "../ipc";
import {
  computeDims,
  focusCanvas,
  getCellMetrics,
  reflowActive,
} from "./terminal";
import { spawnSsh, useTabs } from "./tabs";

export async function resolveAuth(host: SshHostRow): Promise<SshAuthConfig> {
  if (host.auth_method === "agent") return { kind: "agent" };
  if (host.auth_method === "password") {
    const pw = await loadSecret(hostPasswordKey(host.id));
    if (pw == null) {
      throw new Error("Password missing from Stronghold — edit the host and re-enter.");
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
  const passphrase = await loadSecret(keyPassphraseKey(host.key_id));
  return { kind: "key", private_key: privateKey, passphrase };
}

export async function connectHost(host: SshHostRow): Promise<void> {
  const { active } = useTabs();
  reflowActive(active.value);
  const { cellWidthPx, cellHeightPx, dpr } = getCellMetrics();
  const dims = computeDims();
  const auth = await resolveAuth(host);
  const fwds = await listPortForwards(host.id);
  await spawnSsh({
    hostId: host.id,
    hostLabel: host.label,
    cols: dims.cols,
    rows: dims.rows,
    cellWidthPx: Math.round(cellWidthPx * dpr),
    cellHeightPx: Math.round(cellHeightPx * dpr),
    config: {
      host_id: host.id,
      label: host.label,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
      auth,
      stored_fingerprint: host.host_fp_sha256,
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
    },
  });
  focusCanvas();
}
