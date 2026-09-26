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
import { ensureOllama, stopOllama, stopOllamaSync, listOllamaModels, OllamaError, type OllamaHandle } from "../net/ollama";
import {
  sshReachable,
  bootstrapRemote,
  bootstrapRemoteSync,
  bootoutRemote,
  bootoutRemoteSync,
} from "../net/ssh";

// cluster: Pattern A, attached to the server node's LaunchAgent
// local:   whole model served by a process this CLI spawned on this Mac
// shard:   Pattern B, tensor-parallel across all nodes via mlx.launch
// ollama:  served by a local Ollama daemon
export type Mode = "cluster" | "local" | "shard" | "ollama";
// attached: server was already running, ours to use but not stop. started: ours to stop on quit.
export type ClusterOrigin = "attached" | "started" | null;
// fallback: server node was unreachable. takeover: deliberate (wear-leveling or /mode solo).
export type LocalOrigin = "fallback" | "takeover" | null;

export interface Session {
  mode: Mode;
  base: string; // chat API base url of whichever node/process is serving
  model: string;
  localHandle: LocalServerHandle | null; // local mode only
  distributedHandle: DistributedServerHandle | null; // shard mode only
  ollamaHandle: OllamaHandle | null; // ollama mode only; proc is null if we attached, not started
  serverSshOk: boolean; // needed for /model switch in cluster mode
  clusterOrigin: ClusterOrigin;
  localOrigin: LocalOrigin;
  // Set when this session stopped the server node's LaunchAgent; disconnect() restarts it.
  tookOverFromServer: boolean;
}

// config.agentModel needs on-demand cache loading (cluster mode only); local/shard sessions are
// pinned to one loaded model, so /agent runs on whatever's already up rather than swapping it out.
export function agentModelFor(config: ClusterConfig, session: Session): string {
  return session.mode === "cluster" ? config.agentModel : session.model;
}

// Attach-first: if something healthy already answers on the local port, use it instead of
// starting a second one; localHandle stays null so quit never kills a process we don't own.
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

// Decides cluster vs local-fallback mode. Bootstraps the server node's LaunchAgent if it's down
// but SSH-reachable (and remembers to stop it on quit); attaches without touching lifecycle if
// it was already running. Throws only if nowhere can serve the model.
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
      onStatus(`${server.id} unreachable via SSH too — falling back to local mode on your Mac`);
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
      ollamaHandle: null,
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
    ollamaHandle: null,
    serverSshOk: false,
    clusterOrigin: null,
    localOrigin: "fallback",
    tookOverFromServer: false,
  };
}

// Wear-leveling variant of connect(): deliberately serves from the peer, stopping the server
// node first so its GPU actually rests. Failing to stop it is logged but non-fatal.
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
    ollamaHandle: null,
    serverSshOk: false,
    clusterOrigin: null,
    localOrigin: "takeover",
    tookOverFromServer,
  };
}

// /mode solo: mechanically identical to the wear-leveling takeover, just user-invoked.
export const startSolo = connectPreferPeer;

// /mode server: back to Pattern A, attach to (or bootstrap) the server node's LaunchAgent.
export const startServer = connect;

// /mode cluster: refuses if the model isn't HF-cached on every node (sharded loading reads
// each rank's local cache). Restarts the server node's LaunchAgent if the launch fails after
// stopping it, so a failed cluster launch doesn't strand you with nothing serving.
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
      ollamaHandle: null,
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

// /mode ollama: serves through a local Ollama daemon, reusing its own model store so
// `ollama pull`-ed models don't need a second HF-cache download. Doesn't touch the server
// node at all. The model must already be pulled — an unpulled name reports what IS available.
export async function startOllama(
  config: ClusterConfig,
  model: string,
  onStatus: (line: string) => void,
): Promise<Session> {
  const { host, port } = config.ollama;
  const handle = await ensureOllama(host, port, onStatus);

  const available = await listOllamaModels(host, port).catch(() => [] as { repo: string }[]);
  if (available.length && !available.some((m) => m.repo === model)) {
    await stopOllama(handle, model); // no-op if we attached rather than started it
    throw new OllamaError(
      `ollama has no model "${model}" — pull it first (\`ollama pull ${model}\`). ` +
        `Available: ${available.map((m) => m.repo).join(", ")}`,
    );
  }

  onStatus(`serving ${model} through ollama`);
  return {
    mode: "ollama",
    base: handle.base,
    model,
    localHandle: null,
    distributedHandle: null,
    ollamaHandle: handle,
    serverSshOk: false,
    clusterOrigin: null,
    localOrigin: null,
    tookOverFromServer: false,
  };
}

// Tears down current serving WITHOUT restoring the LaunchAgent (only quit's disconnect() does
// that). Callers must carry tookOverFromServer forward onto the replacement session.
export async function stopCurrentSession(
  config: ClusterConfig,
  session: Session,
  onStatus?: (line: string) => void,
): Promise<void> {
  if (session.mode === "local") stopLocalServer(session.localHandle);
  else if (session.mode === "shard") await stopDistributedServer(session.distributedHandle, config);
  else if (session.mode === "ollama") await stopOllama(session.ollamaHandle, session.model, onStatus);
  // "cluster": nothing to stop — the LaunchAgent keeps running.
}

/** Normal quit path — awaited, can do the SSH round trip to bootout. */
export async function disconnect(
  config: ClusterConfig,
  session: Session | null,
  onStatus?: (line: string) => void,
): Promise<void> {
  if (!session) return;
  if (session.mode === "local" || session.mode === "shard" || session.mode === "ollama") {
    if (session.mode === "local") stopLocalServer(session.localHandle);
    else if (session.mode === "ollama") await stopOllama(session.ollamaHandle, session.model, onStatus);
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
    if (!result.ok) console.error(result.message); // best-effort — quitting shouldn't crash on this
  }
}

// Safety-net for process 'exit' / uncaughtException, where Node won't run async work.
export function disconnectSync(config: ClusterConfig, session: Session | null): void {
  if (!session) return;
  if (session.mode === "local" || session.mode === "shard" || session.mode === "ollama") {
    if (session.mode === "local") stopLocalServer(session.localHandle);
    else if (session.mode === "ollama") stopOllamaSync(session.ollamaHandle, session.model);
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
