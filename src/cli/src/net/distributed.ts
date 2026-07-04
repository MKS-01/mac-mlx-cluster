// Pattern B: tensor-parallel sharding across both Macs via mlx.launch.
// mlx_lm.server has native distributed support (it detects the group and
// loads via sharded_load; rank 0 serves the normal OpenAI-compatible HTTP
// API), so nothing custom runs on the nodes — this module only owns
// launching and tearing down the mlx.launch process group.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ClusterConfig } from "../config/config";
import { checkHealth } from "./server";
import { runRemote } from "./ssh";

export interface DistributedServerHandle {
  base: string; // http://<rank0-ip>:<port>
  proc: ReturnType<typeof Bun.spawn>; // the mlx.launch process itself
}

export class DistributedLaunchError extends Error {}

// Distributed cold load is slower than a local one (both ranks load their
// shard, then sync over the bridge) — budget well past local mode's 120s.
const STARTUP_TIMEOUT_MS = 240_000;

function expandTilde(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/**
 * Rank 0's IP, read from the hostfile itself (first entry = rank 0,
 * mlx.launch's own convention) so the HTTP endpoint's address has exactly
 * one source of truth — the same file mlx.launch reads.
 */
export function rankZeroIp(hostfilePath: string): string {
  const path = expandTilde(hostfilePath);
  if (!existsSync(path)) {
    throw new DistributedLaunchError(
      `hostfile not found at ${path} — copy src/cluster/hostfile.example.json there (see CLUSTER_SETUP.md §5)`,
    );
  }
  let entries: unknown;
  try {
    entries = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new DistributedLaunchError(`hostfile ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const first = Array.isArray(entries) ? entries[0] : undefined;
  const ip = first && typeof first === "object" ? (first as { ips?: string[] }).ips?.[0] : undefined;
  if (!ip) {
    throw new DistributedLaunchError(
      `hostfile ${path} has no ips[] on its first entry — expected the shape in src/cluster/hostfile.example.json`,
    );
  }
  return ip;
}

/**
 * Launches mlx_lm.server sharded across every node in the hostfile via
 * `mlx.launch --backend ring`, and waits until rank 0 answers the health
 * check. The child's stdin is never connected to ours — piping stdin into
 * mlx.launch corrupts its launcher bookkeeping (CLUSTER_SETUP.md gotcha).
 */
export async function startDistributedServer(
  config: ClusterConfig,
  model: string,
  onStatus: (line: string) => void,
): Promise<DistributedServerHandle> {
  const hostfile = expandTilde(config.distributed.hostfile);
  const ip = rankZeroIp(hostfile); // also validates the hostfile exists/parses
  const launcher = join(config.venvPath, "bin", "mlx.launch");
  if (!existsSync(launcher)) {
    throw new DistributedLaunchError(`mlx.launch not found at ${launcher} — is the MLX venv set up?`);
  }

  const base = `http://${ip}:${config.localApiPort}`;
  if (await checkHealth(base, 800)) {
    throw new DistributedLaunchError(
      `something is already serving at ${base} — stop it first (a previous sharded group may still be running)`,
    );
  }

  onStatus(`launching ${model} sharded across the cluster (this can take a few minutes)…`);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      [
        launcher,
        "--hostfile", hostfile,
        "--backend", "ring",
        "--python", join(config.venvPath, "bin", "python"),
        "--",
        join(config.venvPath, "bin", "mlx_lm.server"),
        "--model", model,
        "--host", "0.0.0.0",
        "--port", String(config.localApiPort),
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
  } catch (err) {
    throw new DistributedLaunchError(`failed to spawn mlx.launch: ${String(err)}`);
  }

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      let detail = "";
      try {
        detail = await new Response(proc.stderr as ReadableStream).text();
      } catch {
        // best-effort — proc may already be fully reaped
      }
      throw new DistributedLaunchError(
        `mlx.launch exited during startup (code ${proc.exitCode})` +
          (detail ? `\n${detail.trim().split("\n").slice(-8).join("\n")}` : ""),
      );
    }
    if (await checkHealth(base, 1000)) return { base, proc };
    await Bun.sleep(1000);
  }
  await stopDistributedServer({ base, proc }, config);
  throw new DistributedLaunchError(
    `sharded server did not become healthy within ${STARTUP_TIMEOUT_MS / 1000}s — ` +
      `check the model is cached on every node and the bridge is up (CLUSTER_SETUP.md §7)`,
  );
}

// Belt-and-braces: whether mlx.launch reaps its SSH'd remote rank on SIGTERM
// is unverified on this hardware, so always clear any leftover mlx_lm.server
// on the server node too (idempotent — same thing mlxctl clean does locally).
// The local rank is a child of mlx.launch and dies with it; the CLI runs on
// the peer, so the only rank we can't see is the server node's.
function killRemoteRankCmd(): string {
  return "pkill -f mlx_lm.server || true";
}

/**
 * Stops the whole distributed group: SIGTERM mlx.launch, escalate to
 * SIGKILL if it lingers, then sweep the server node for an orphaned rank.
 */
export async function stopDistributedServer(
  handle: DistributedServerHandle | null,
  config: ClusterConfig,
): Promise<void> {
  if (handle && handle.proc.exitCode === null) {
    handle.proc.kill("SIGTERM");
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000));
    const race = await Promise.race([handle.proc.exited.then(() => "exited" as const), timeout]);
    if (race === "timeout") handle.proc.kill("SIGKILL");
  }
  await runRemote(config.server.sshUser, config.server.ip, killRemoteRankCmd(), 8000);
}

/**
 * Synchronous, best-effort teardown for process exit / uncaughtException
 * handlers (Node won't run async work there) — SIGTERM so mlx.launch gets a
 * chance to reap its remote rank, plus the same remote sweep, blocking.
 */
export function stopDistributedServerSync(handle: DistributedServerHandle | null, config: ClusterConfig): void {
  try {
    if (handle && handle.proc.exitCode === null) handle.proc.kill("SIGTERM");
    Bun.spawnSync(
      [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=5",
        "-o", "StrictHostKeyChecking=accept-new",
        `${config.server.sshUser}@${config.server.ip}`,
        killRemoteRankCmd(),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
  } catch {
    // best-effort only — never let cleanup crash the exit path
  }
}
