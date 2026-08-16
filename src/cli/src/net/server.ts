import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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

/** `model_type` from a repo's cached snapshot config, or null if unreadable. */
function cachedModelType(repo: string): string | null {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const snapshots = join(homedir(), ".cache/huggingface/hub", `models--${repo.replace("/", "--")}`, "snapshots");
  try {
    for (const rev of readdirSync(snapshots)) {
      const cfg = join(snapshots, rev, "config.json");
      if (!existsSync(cfg)) continue;
      const parsed = JSON.parse(readFileSync(cfg, "utf8"));
      return typeof parsed.model_type === "string" ? parsed.model_type : null;
    }
  } catch {
    // not cached, unreadable, or malformed config
  }
  return null;
}

/** True if the venv's mlx_lm ships an implementation of this model_type. */
function mlxLmSupports(venvPath: string, modelType: string): boolean {
  const lib = join(venvPath, "lib");
  try {
    for (const py of readdirSync(lib)) {
      const models = join(lib, py, "site-packages/mlx_lm/models");
      if (existsSync(models)) return existsSync(join(models, `${modelType}.py`));
    }
  } catch {
    // no venv lib dir — let the spawn itself produce the real error
  }
  return true; // unknown layout: keep the historical mlx_lm default
}

/**
 * Picks which server binary serves a repo. Multimodal models mlx_lm has no
 * implementation for (Muse-Glimmer) must run under `mlx_vlm.server`; mlx_lm
 * rejects them with "Model type <x> not supported" — but only when the first
 * request triggers the lazy load, so /v1/models answers fine and the failure
 * looks like a broken connection rather than the wrong binary.
 *
 * Deliberately keyed on what mlx_lm actually supports rather than on the
 * config having a `vision_config`: some repos (Qwen3.5) are multimodal AND
 * implemented in both packages, and those should keep using mlx_lm as they
 * always have. Anything mlx_lm can't load falls to mlx_vlm.
 */
export function pickServerBinary(venvPath: string, repo: string): "mlx_lm.server" | "mlx_vlm.server" {
  const modelType = cachedModelType(repo);
  if (!modelType) return "mlx_lm.server";
  return mlxLmSupports(venvPath, modelType) ? "mlx_lm.server" : "mlx_vlm.server";
}

/**
 * Spawns the venv's model server (`mlx_lm.server`, or `mlx_vlm.server` for
 * vision models — see isVisionModel), bound to localhost, and waits for it
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
  const server = pickServerBinary(venvPath, model);
  const bin = join(venvPath, "bin", server);
  if (!existsSync(bin)) {
    throw new LocalSpawnError(
      server === "mlx_vlm.server"
        ? `${model} is a vision model and needs mlx_vlm.server, which isn't at ${bin} — ` +
          `install it with: ${join(venvPath, "bin", "pip")} install -U mlx-vlm`
        : `mlx_lm.server not found at ${bin} — is the MLX venv set up? (see CLAUDE.md)`,
    );
  }

  const base = `http://127.0.0.1:${port}`;

  // Normal connects attach to an already-healthy server before ever getting
  // here (cluster.ts attachOrStartLocal) — reaching this means something
  // grabbed the port mid-session (e.g. between a /model switch's stop and
  // respawn), which isn't ours to replace.
  if (await health(base, 800)) {
    throw new LocalSpawnError(
      `another server is already answering on port ${port} — stop it first, or restart ` +
        `the CLI with a different --local-port`,
    );
  }

  onStatus(`starting ${server} locally (${model})…`);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, "--model", model, "--host", "127.0.0.1", "--port", String(port)], {
      stdout: "ignore",
      stderr: "pipe",
    });
  } catch (err) {
    throw new LocalSpawnError(`failed to spawn ${server}: ${String(err)}`);
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
        `${server} exited during startup (code ${proc.exitCode})` +
          (detail ? `\n${detail.trim().split("\n").slice(-8).join("\n")}` : ""),
      );
    }
    if (await health(base, 1000)) return { base, proc };
    await Bun.sleep(500);
  }
  proc.kill("SIGKILL");
  throw new LocalSpawnError(
    `${server} did not become healthy within 120s (model too large for RAM, or still downloading — check mlxctl status)`,
  );
}

export function stopLocalServer(handle: LocalServerHandle | null): void {
  if (!handle || handle.proc.exitCode !== null) return;
  handle.proc.kill("SIGKILL");
}
