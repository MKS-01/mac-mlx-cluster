import type { ClusterConfig } from "./config";
import { isServerUp, pollUntilHealthy, startLocalServer, stopLocalServer, type LocalServerHandle } from "./server";
import { sshReachable, bootstrapRemote, bootoutRemote, bootoutRemoteSync } from "./ssh";

export type Mode = "cluster" | "local";
// cluster: "attached" — server was already running, ours to use but not to stop
//          "started"  — we bootstrapped it ourselves, ours to stop on quit
export type ClusterOrigin = "attached" | "started" | null;

export interface Session {
  mode: Mode;
  base: string; // chat API base url, whichever node/process is actually serving
  model: string;
  // only set in local mode — the process this CLI spawned and owns
  localHandle: LocalServerHandle | null;
  // true if the designated server node answered SSH (needed for /model switch in cluster mode)
  serverSshOk: boolean;
  clusterOrigin: ClusterOrigin;
}

/**
 * Decides cluster vs local-fallback mode and gets a model serving somewhere.
 *
 * Cluster mode now owns the M1's server lifecycle the same way local mode
 * owns its spawned process: if nothing is running there but SSH works, this
 * starts it (bootstrap/kickstart) and remembers that so disconnect() stops
 * it again on quit. If it was already running before we got here, we attach
 * without touching its lifecycle — could be another session's, and Pattern
 * A's whole point was "always-on shared infra," so we don't assume ownership
 * of something we didn't start.
 *
 * Only throws if there's truly nowhere to serve the model from (M1
 * unreachable by both HTTP and SSH, or unreachable and local spawn itself
 * fails).
 */
export async function connect(
  config: ClusterConfig,
  preferredModel: string | undefined,
  onStatus: (line: string) => void,
): Promise<Session> {
  const { server } = config;
  const model = preferredModel ?? config.defaultModel;

  onStatus(`checking ${server.id} (${server.ip}:${server.apiPort})…`);
  let up = await isServerUp(server.ip, server.apiPort, 2500);
  let clusterOrigin: ClusterOrigin = up ? "attached" : null;

  if (!up) {
    onStatus(`${server.id} not answering — checking SSH…`);
    const sshOk = await sshReachable(server.sshUser, server.ip, 3000);
    if (sshOk) {
      onStatus(`starting ${server.serviceLabel} on ${server.id}…`);
      const started = await bootstrapRemote(server.sshUser, server.ip, server.plistPath, server.serviceLabel);
      if (started.ok) {
        onStatus(`waiting for ${server.id} to come up…`);
        up = await pollUntilHealthy(server.ip, server.apiPort, 60_000);
        if (up) clusterOrigin = "started";
        else onStatus(`${server.id} did not come up in time — falling back to local mode`);
      } else {
        onStatus(`${started.message} — falling back to local mode`);
      }
    } else {
      onStatus(`${server.id} unreachable via SSH too — falling back to local mode on this Mac`);
    }
  }

  if (up) {
    const serverSshOk = await sshReachable(server.sshUser, server.ip, 3000);
    onStatus(`${clusterOrigin === "started" ? "started" : "attached to"} ${server.id} — cluster mode`);
    return {
      mode: "cluster",
      base: `http://${server.ip}:${server.apiPort}`,
      model,
      localHandle: null,
      serverSshOk,
      clusterOrigin,
    };
  }

  const handle = await startLocalServer(config.venvPath, model, config.localApiPort, onStatus);
  return { mode: "local", base: handle.base, model, localHandle: handle, serverSshOk: false, clusterOrigin: null };
}

/** Normal quit path — awaited, can do the SSH round trip to bootout. */
export async function disconnect(config: ClusterConfig, session: Session | null): Promise<void> {
  if (!session) return;
  if (session.mode === "local") {
    stopLocalServer(session.localHandle);
    return;
  }
  if (session.clusterOrigin === "started") {
    const result = await bootoutRemote(config.server.sshUser, config.server.ip, config.server.serviceLabel);
    if (!result.ok) {
      // Best-effort — quitting shouldn't hang or crash on a cleanup failure.
      console.error(result.message);
    }
  }
}

/**
 * Safety-net cleanup for process 'exit' / uncaughtException, where Node
 * won't run async work — covers the case where something skipped the
 * normal awaited disconnect() above (e.g. an uncaught error).
 */
export function disconnectSync(config: ClusterConfig, session: Session | null): void {
  if (!session) return;
  if (session.mode === "local") {
    stopLocalServer(session.localHandle);
    return;
  }
  if (session.clusterOrigin === "started") {
    bootoutRemoteSync(config.server.sshUser, config.server.ip, config.server.serviceLabel);
  }
}
