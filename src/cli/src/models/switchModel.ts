import type { ClusterConfig } from "../config/config";
import type { Session } from "../cluster/cluster";
import { pollUntilHealthy, startLocalServer, stopLocalServer } from "../net/server";
import { startDistributedServer, stopDistributedServer } from "../net/distributed";
import { checkCachedOnBothNodes } from "./models";
import { setRemoteModel, kickstartRemote } from "../net/ssh";

export interface SwitchResult {
  ok: boolean;
  message: string;
  session?: Session;
}

// Switches the served model without restarting the CLI. Cluster mode edits the remote plist
// and kickstarts it; local mode kills and respawns the owned process.
export async function switchModel(
  config: ClusterConfig,
  session: Session,
  newModel: string,
  onStatus: (line: string) => void,
): Promise<SwitchResult> {
  // Shard mode: full teardown + relaunch. Cache checked before stopping, so a bad target
  // leaves the current model serving.
  if (session.mode === "shard") {
    const cache = await checkCachedOnBothNodes(config, newModel);
    if (!cache.ok) {
      return {
        ok: false,
        message:
          cache.reason ??
          `${newModel} is not cached on: ${cache.missingOn.join(", ")} — sharding needs it on every node. ` +
            `Copy it over first (model-transfer skill, or the rsync in CLUSTER_SETUP.md §7).`,
      };
    }
    onStatus(`stopping the sharded group…`);
    await stopDistributedServer(session.distributedHandle, config);
    try {
      const handle = await startDistributedServer(config, newModel, onStatus);
      return {
        ok: true,
        message: `model → ${newModel}`,
        session: { ...session, model: newModel, distributedHandle: handle, base: handle.base },
      };
    } catch (err) {
      return { ok: false, message: `failed to relaunch the sharded group: ${(err as Error).message}` };
    }
  }

  if (session.mode === "local") {
    // Attached (localHandle null): the server belongs to someone else, not ours to kill.
    if (!session.localHandle) {
      return {
        ok: false,
        message:
          `this session attached to a local server it doesn't own (port ${config.localApiPort}) — ` +
          `switch the model there, or stop it and /mode solo to spawn our own`,
      };
    }
    onStatus(`stopping local server…`);
    stopLocalServer(session.localHandle);
    try {
      const handle = await startLocalServer(config.venvPath, newModel, config.localApiPort, onStatus);
      return {
        ok: true,
        message: `model → ${newModel}`,
        session: { ...session, model: newModel, localHandle: handle, base: handle.base },
      };
    } catch (err) {
      return { ok: false, message: `failed to switch model: ${(err as Error).message}` };
    }
  }

  // Cluster mode: edit the remote plist + kickstart, no local process to manage.
  if (!session.serverSshOk) {
    return {
      ok: false,
      message:
        `can't switch model — SSH to ${config.server.sshUser}@${config.server.ip} isn't working ` +
        `(needed to edit the LaunchAgent). Check CLUSTER_SETUP.md §3.`,
    };
  }

  onStatus(`updating ${config.server.serviceLabel} plist on ${config.server.id}…`);
  const editResult = await setRemoteModel(config.server.sshUser, config.server.ip, config.server.plistPath, newModel);
  if (!editResult.ok) return { ok: false, message: editResult.message };

  onStatus(`restarting ${config.server.serviceLabel}…`);
  const kickResult = await kickstartRemote(config.server.sshUser, config.server.ip, config.server.serviceLabel);
  if (!kickResult.ok) return { ok: false, message: kickResult.message };

  onStatus(`waiting for ${config.server.id} to come back up with ${newModel}…`);
  const up = await pollUntilHealthy(config.server.ip, config.server.apiPort, 60_000); // model load time varies
  if (up) return { ok: true, message: `model → ${newModel}`, session: { ...session, model: newModel } };
  return {
    ok: false,
    message:
      `${config.server.id} did not come back healthy within 60s after switching to ${newModel} — ` +
      `it may not be in the HF cache on that node, or is too large. Check the server log over SSH.`,
  };
}
