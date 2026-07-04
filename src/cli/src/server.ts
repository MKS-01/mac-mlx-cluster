import { existsSync } from "node:fs";
import { join } from "node:path";

export interface LocalServerHandle {
  base: string;
  proc: ReturnType<typeof Bun.spawn>;
}

async function health(base: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export { health as checkHealth };

/** True/false — used by cluster.ts to decide cluster vs local-fallback mode. */
export async function isServerUp(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return health(`http://${host}:${port}`, timeoutMs);
}

/**
 * Polls until the server at host:port answers or timeoutMs elapses. Used
 * after any remote start/restart (initial connect, /model switch) — a model
 * load can take anywhere from a couple seconds to a minute-plus.
 */
export async function pollUntilHealthy(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUp(host, port, 2000)) return true;
    await Bun.sleep(1000);
  }
  return false;
}

export class LocalSpawnError extends Error {}

/**
 * Spawns `mlx_lm.server` from the venv, bound to localhost, and waits for it
 * to become healthy. Used only in local-fallback mode (the M1's LaunchAgent
 * unreachable) — this CLI owns the process for the session and kills it on
 * quit (see stopLocalServer).
 */
export async function startLocalServer(
  venvPath: string,
  model: string,
  port: number,
  onStatus: (line: string) => void,
): Promise<LocalServerHandle> {
  const bin = join(venvPath, "bin", "mlx_lm.server");
  if (!existsSync(bin)) {
    throw new LocalSpawnError(
      `mlx_lm.server not found at ${bin} — is the MLX venv set up? (see CLAUDE.md)`,
    );
  }

  const base = `http://127.0.0.1:${port}`;

  if (await health(base, 800)) {
    throw new LocalSpawnError(
      `port ${port} is already serving something that isn't healthy as expected, or another ` +
        `mlx_lm.server is already running locally — stop it first or pick a different --local-port`,
    );
  }

  onStatus(`starting mlx_lm.server locally (${model})…`);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, "--model", model, "--host", "127.0.0.1", "--port", String(port)], {
      stdout: "ignore",
      stderr: "pipe",
    });
  } catch (err) {
    throw new LocalSpawnError(`failed to spawn mlx_lm.server: ${String(err)}`);
  }

  const deadline = Date.now() + 120_000; // first cold load of a big model can take a while
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      let detail = "";
      try {
        detail = await new Response(proc.stderr as ReadableStream).text();
      } catch {
        // best-effort — proc may already be fully reaped
      }
      throw new LocalSpawnError(
        `mlx_lm.server exited during startup (code ${proc.exitCode})` +
          (detail ? `\n${detail.trim().split("\n").slice(-8).join("\n")}` : ""),
      );
    }
    if (await health(base, 1000)) return { base, proc };
    await Bun.sleep(500);
  }
  proc.kill("SIGKILL");
  throw new LocalSpawnError(
    `mlx_lm.server did not become healthy within 120s (model too large for RAM, or still downloading — check mlxctl status)`,
  );
}

export function stopLocalServer(handle: LocalServerHandle | null): void {
  if (!handle || handle.proc.exitCode !== null) return;
  handle.proc.kill("SIGKILL");
}
