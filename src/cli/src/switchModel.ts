import type { ClusterConfig } from "./config";
import type { Session } from "./cluster";
import { pollUntilHealthy, startLocalServer, stopLocalServer } from "./server";
import { setRemoteModel, kickstartRemote } from "./ssh";

export interface SwitchResult {
  ok: boolean;
  message: string;
  session?: Session;
}

/**
 * Switches the served model, without restarting the CLI. In cluster mode
 * this edits the remote LaunchAgent plist and kickstarts it (a few seconds
 * of downtime); in local mode it kills and respawns the process this CLI
 * owns. Reports a clear error at whichever step fails instead of leaving
 * the session in a half-switched state silently.
 */
export async function switchModel(
  config: ClusterConfig,
  session: Session,
  newModel: string,
  onStatus: (line: string) => void,
): Promise<SwitchResult> {
  if (session.mode === "local") {
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
