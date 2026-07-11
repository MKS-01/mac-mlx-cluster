import type { ClusterConfig } from "../config/config";
import {
  checkHealth,
  isServerUp,
  pollUntilHealthy,
  startLocalServer,
  stopLocalServer,
  type LocalServerHandle,
} from "../net/server";
import {
  startDistributedServer,
  stopDistributedServer,
  stopDistributedServerSync,
  type DistributedServerHandle,
} from "../net/distributed";
import { checkCachedOnBothNodes } from "../models/models";
import {
  sshReachable,
  bootstrapRemote,
  bootstrapRemoteSync,
  bootoutRemote,
  bootoutRemoteSync,
} from "../net/ssh";

// cluster: Pattern A — attached to the server node's LaunchAgent
// local:   whole model served by a process this CLI spawned on this Mac
// shard:   Pattern B — tensor-parallel across all nodes via mlx.launch
export type Mode = "cluster" | "local" | "shard";
// cluster: "attached" — server was already running, ours to use but not to stop
//          "started"  — we bootstrapped it ourselves, ours to stop on quit
export type ClusterOrigin = "attached" | "started" | null;
// local:   "fallback" — server node was unreachable, this Mac stepped in
//          "takeover" — deliberate (wear-leveling turn or /mode solo)
export type LocalOrigin = "fallback" | "takeover" | null;

export interface Session {
  mode: Mode;
  base: string; // chat API base url, whichever node/process is actually serving
  model: string;
  // only set in local mode — the process this CLI spawned and owns
  localHandle: LocalServerHandle | null;
  // only set in shard mode — the mlx.launch group this CLI spawned and owns
  distributedHandle: DistributedServerHandle | null;
  // true if the designated server node answered SSH (needed for /model switch in cluster mode)
  serverSshOk: boolean;
  clusterOrigin: ClusterOrigin;
  localOrigin: LocalOrigin;
  // true for sessions that stopped the server node's always-on LaunchAgent
  // to serve some other way (wear-leveling takeover, /mode solo, /mode
  // cluster) — disconnect() restarts it so Pattern A's "always-on"
  // invariant holds again once this session ends.
  tookOverFromServer: boolean;
}

/**
 * Local serving with attach-first semantics: if something healthy is already
 * answering on the local port — typically an mlx_lm.server the OpenCode
 * coding-agent harness (see ARCHITECTURE.md) or a previous session left
 * running — use it instead of failing to start a second one (which would
 * double model RAM anyway). localHandle stays null so quit never kills a
 * process this session doesn't own. The attached server keeps serving
 * whatever model it was started with; /model on such a session is refused
 * (see switchModel.ts).
 */
async function attachOrStartLocal(
  config: ClusterConfig,
  model: string,
  onStatus: (line: string) => void,
): Promise<{ base: string; localHandle: LocalServerHandle | null }> {
  const base = `http://127.0.0.1:${config.localApiPort}`;
  if (await checkHealth(base, 800)) {
    onStatus(
      `a server is already running on port ${config.localApiPort} — attaching to it ` +
        `(it serves whatever model it was started with)`,
    );
    return { base, localHandle: null };
  }
  const handle = await startLocalServer(config.venvPath, model, config.localApiPort, onStatus);
  return { base: handle.base, localHandle: handle };
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
      distributedHandle: null,
      serverSshOk,
      clusterOrigin,
      localOrigin: null,
      tookOverFromServer: false,
    };
  }

  const { base, localHandle } = await attachOrStartLocal(config, model, onStatus);
  return {
    mode: "local",
    base,
    model,
    localHandle,
    distributedHandle: null,
    serverSshOk: false,
    clusterOrigin: null,
    localOrigin: "fallback",
    tookOverFromServer: false,
  };
}

/**
 * Wear-leveling variant of connect(): deliberately serves from the peer
 * (wherever this CLI is running) instead of the server node, even if the
 * server node is currently up — stopping it first so its GPU actually gets
 * a rest instead of sitting loaded-but-idle. Used when splitPolicy.ts
 * recommends the peer's turn and the user confirms at startup (see
 * index.tsx). Always succeeds or throws the same way startLocalServer does;
 * failing to stop the server node is logged but non-fatal, since serving
 * locally is the actual goal.
 */
export async function connectPreferPeer(
  config: ClusterConfig,
  preferredModel: string | undefined,
  onStatus: (line: string) => void,
): Promise<Session> {
  const { server } = config;
  const model = preferredModel ?? config.defaultModel;
  let tookOverFromServer = false;

  const up = await isServerUp(server.ip, server.apiPort, 2500);
  if (up) {
    onStatus(`stopping ${server.id}'s server to free it up for this session…`);
    const sshOk = await sshReachable(server.sshUser, server.ip, 3000);
    if (sshOk) {
      const result = await bootoutRemote(server.sshUser, server.ip, server.serviceLabel);
      if (result.ok) tookOverFromServer = true;
      else onStatus(`${result.message} — continuing to serve locally anyway`);
    } else {
      onStatus(`can't SSH to ${server.id} to stop it — continuing to serve locally anyway`);
    }
  }

  const { base, localHandle } = await attachOrStartLocal(config, model, onStatus);
  return {
    mode: "local",
    base,
    model,
    localHandle,
    distributedHandle: null,
    serverSshOk: false,
    clusterOrigin: null,
    localOrigin: "takeover",
    tookOverFromServer,
  };
}

/**
 * /mode solo — deliberately serve the model on this Mac only, stopping the
 * server node's always-on LaunchAgent first so its memory is actually
 * freed. Mechanically identical to the wear-leveling takeover, just
 * user-invoked.
 */
export const startSolo = connectPreferPeer;

/**
 * /mode server — back to Pattern A: attach to (or bootstrap) the server
 * node's LaunchAgent. Same logic as the startup connect(); the caller is
 * responsible for tearing down whatever was serving before (see
 * stopCurrentSession) and for clearing a prior takeover's restore-on-quit
 * obligation, since the LaunchAgent running again IS the restoration.
 */
export const startServer = connect;

/**
 * /mode cluster — Pattern B: stop whatever Pattern A serving is up, then
 * launch the model tensor-parallel across every node in the hostfile and
 * point the session at rank 0's HTTP endpoint. Refuses (with the node named)
 * if the model isn't already HF-cached everywhere — sharded loading reads
 * each rank's local cache, and multi-GB copies stay a deliberate user step
 * (model-transfer skill / CLUSTER_SETUP.md §7 rsync).
 *
 * If the launch fails after the server node's LaunchAgent was already
 * stopped, a best-effort restart of it runs before the error propagates, so
 * a failed cluster launch doesn't strand you with nothing serving.
 */
export async function startCluster(
  config: ClusterConfig,
  model: string,
  onStatus: (line: string) => void,
): Promise<Session> {
  const { server } = config;

  onStatus(`checking ${model} is cached on every node…`);
  const cache = await checkCachedOnBothNodes(config, model);
  if (!cache.ok) {
    throw new Error(
      cache.reason ??
        `${model} is not cached on: ${cache.missingOn.join(", ")} — sharding needs it on every node. ` +
          `Copy it over first (model-transfer skill, or the rsync in CLUSTER_SETUP.md §7).`,
    );
  }

  let tookOverFromServer = false;
  const up = await isServerUp(server.ip, server.apiPort, 2500);
  if (up) {
    onStatus(`stopping ${server.id}'s standalone server to free its memory for sharding…`);
    const sshOk = await sshReachable(server.sshUser, server.ip, 3000);
    const result = sshOk
      ? await bootoutRemote(server.sshUser, server.ip, server.serviceLabel)
      : { ok: false as const, message: `can't SSH to ${server.id} to stop it` };
    if (!result.ok) {
      throw new Error(`${result.message} — a sharded launch can't share ${server.id} with the standalone server`);
    }
    tookOverFromServer = true;
  }

  try {
    const handle = await startDistributedServer(config, model, onStatus);
    onStatus(`sharded across the cluster — serving at ${handle.base}`);
    return {
      mode: "shard",
      base: handle.base,
      model,
      localHandle: null,
      distributedHandle: handle,
      serverSshOk: await sshReachable(server.sshUser, server.ip, 3000),
      clusterOrigin: null,
      localOrigin: null,
      tookOverFromServer,
    };
  } catch (err) {
    if (tookOverFromServer) {
      onStatus(`sharded launch failed — restoring ${server.id}'s standalone server…`);
      await bootstrapRemote(server.sshUser, server.ip, server.plistPath, server.serviceLabel);
    }
    throw err;
  }
}

/**
 * Tears down whatever the current session is serving through, WITHOUT
 * restoring the server node's LaunchAgent — used when switching between
 * modes mid-session (the next start* decides what serves; only quitting
 * restores Pattern A, via disconnect()). Callers must carry
 * tookOverFromServer forward onto the replacement session so the quit-time
 * restore still happens.
 */
export async function stopCurrentSession(config: ClusterConfig, session: Session): Promise<void> {
  if (session.mode === "local") stopLocalServer(session.localHandle);
  else if (session.mode === "shard") await stopDistributedServer(session.distributedHandle, config);
  // "cluster": nothing to stop — the LaunchAgent keeps running until the
  // next start* boots it out (or quit, if this session started it).
}

/** Normal quit path — awaited, can do the SSH round trip to bootout. */
export async function disconnect(config: ClusterConfig, session: Session | null): Promise<void> {
  if (!session) return;
  if (session.mode === "local" || session.mode === "shard") {
    if (session.mode === "local") stopLocalServer(session.localHandle);
    else await stopDistributedServer(session.distributedHandle, config);
    if (session.tookOverFromServer) {
      const result = await bootstrapRemote(
        config.server.sshUser,
        config.server.ip,
        config.server.plistPath,
        config.server.serviceLabel,
      );
      if (!result.ok) console.error(`could not restart ${config.server.id}'s server: ${result.message}`);
    }
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
  if (session.mode === "local" || session.mode === "shard") {
    if (session.mode === "local") stopLocalServer(session.localHandle);
    else stopDistributedServerSync(session.distributedHandle, config);
    if (session.tookOverFromServer) {
      bootstrapRemoteSync(config.server.sshUser, config.server.ip, config.server.plistPath, config.server.serviceLabel);
    }
    return;
  }
  if (session.clusterOrigin === "started") {
    bootoutRemoteSync(config.server.sshUser, config.server.ip, config.server.serviceLabel);
  }
}
