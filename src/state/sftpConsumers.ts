/**
 * SFTP consumer lifecycle for file-browser panes.
 *
 * In the pooled-connection model a file browser owns an SFTP *consumer* on a
 * host's shared connection (see the backend `ConnectionPool`). A consumer id
 * — not a tab id — routes every `sftp_*` call and is released when the browser
 * goes away.
 *
 * The consumer is tied to the **panel pane's lifetime**, NOT the Vue mount:
 * switching tabs unmounts the files panel but must not drop the connection, so
 * release happens only on a real source switch or when the pane is closed
 * (`closePanelLeaf` / workspace teardown call `releaseSftpForPane`). A
 * per-pane generation guards against a slow acquire registering after it was
 * superseded or released.
 */
import { getHost } from "../db";
import { sftpAcquire, sftpRelease } from "../ipc";
import { buildSshConnectConfig } from "./connect";

interface PaneSftp {
  hostId: number;
  consumerId: number;
  label: string;
}

const byPane = new Map<number, PaneSftp>();
const gen = new Map<number, number>();

/** Ensure an SFTP consumer for (pane, host), releasing any previous consumer
 *  on that pane first. Returns the consumer id used to route `sftp_*`. Throws
 *  if the host is gone, auth is cancelled, or the acquire was superseded. */
export async function acquireSftpForPane(paneId: number, hostId: number): Promise<number> {
  const cur = byPane.get(paneId);
  if (cur && cur.hostId === hostId) return cur.consumerId;

  const myGen = (gen.get(paneId) ?? 0) + 1;
  gen.set(paneId, myGen);
  // Switching host (or first acquire on this pane): drop the old consumer.
  if (cur) {
    byPane.delete(paneId);
    sftpRelease(cur.consumerId).catch(() => undefined);
  }

  const host = await getHost(hostId);
  if (!host) throw new Error("Host not found");
  const config = await buildSshConnectConfig(host);
  const consumerId = await sftpAcquire(config);
  // Superseded (another acquire) or released while we were connecting.
  if (gen.get(paneId) !== myGen) {
    sftpRelease(consumerId).catch(() => undefined);
    throw new Error("SFTP acquire superseded");
  }
  byPane.set(paneId, { hostId, consumerId, label: host.label });
  return consumerId;
}

/** Release the pane's SFTP consumer (if any) and invalidate any in-flight
 *  acquire so it releases itself on resolve. Idempotent. */
export function releaseSftpForPane(paneId: number): void {
  gen.set(paneId, (gen.get(paneId) ?? 0) + 1);
  const cur = byPane.get(paneId);
  if (cur) {
    byPane.delete(paneId);
    sftpRelease(cur.consumerId).catch(() => undefined);
  }
}

/** The host id a pane's browser is currently bound to, or null. Lets the
 *  connection-identity helpers report which hosts have a live SFTP consumer. */
export function paneSftpHost(paneId: number): number | null {
  return byPane.get(paneId)?.hostId ?? null;
}

/** Human label for an SFTP consumer id (for the transfer panel), or null. */
export function consumerLabel(consumerId: number): string | null {
  for (const v of byPane.values()) {
    if (v.consumerId === consumerId) return v.label;
  }
  return null;
}
