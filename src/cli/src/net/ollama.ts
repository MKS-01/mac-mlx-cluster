// Ollama as a serving backend: its own MLX runner behind an OpenAI-compatible API, so its
// `-mlx` models are reachable without a second download into the HF cache.
//
// Not provided by Ollama (handled as fallbacks in chat.ts): `prompt_tokens_details` (no
// "cached" figure) and `timings` (tok/s measured client-side instead).

import { checkHealth, pollUntilHealthy } from "./server";
import type { CachedModel } from "../models/models";

export interface OllamaHandle {
  base: string;
  proc: ReturnType<typeof Bun.spawn> | null; // set only when this session spawned the daemon
}

export class OllamaError extends Error {}

// No `/v1` suffix — every consumer appends `/v1/...` itself.
export function ollamaBase(host: string, port: number): string {
  return `http://${host}:${port}`;
}

export async function isOllamaUp(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return checkHealth(ollamaBase(host, port), timeoutMs);
}

// Via native /api/tags (the OpenAI /v1/models route omits sizes); shaped as CachedModel so
// /model can resolve Ollama models through the same path as HF-cached ones.
export async function listOllamaModels(host: string, port: number): Promise<CachedModel[]> {
  const res = await fetch(`http://${host}:${port}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new OllamaError(`ollama /api/tags returned ${res.status}`);
  const data = (await res.json()) as { models?: { name: string; size: number }[] };
  return (data.models ?? [])
    .map((m) => ({ repo: m.name, sizeGB: (m.size ?? 0) / 1024 ** 3 }))
    .sort((a, b) => b.sizeGB - a.sizeGB);
}

// Attach to a running daemon, or start one. A daemon we didn't start is not ours to stop —
// `proc` is null in the attach case so stopOllama() is a no-op there.
export async function ensureOllama(
  host: string,
  port: number,
  onStatus: (line: string) => void,
): Promise<OllamaHandle> {
  const base = ollamaBase(host, port);
  if (await isOllamaUp(host, port, 2000)) {
    onStatus(`attached to ollama at ${host}:${port}`);
    return { base, proc: null };
  }

  onStatus("starting ollama…");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["ollama", "serve"], { stdout: "ignore", stderr: "pipe" });
  } catch (err) {
    throw new OllamaError(
      `could not start ollama (is it installed? https://ollama.com) — ${String(err)}`,
    );
  }
  // Health-poll rather than trusting the spawn: `ollama serve` exits immediately if a daemon
  // already owns the port, which we can just attach to instead of treating as a failure.
  if (!(await pollUntilHealthy(host, port, 20_000))) {
    proc.kill("SIGKILL");
    throw new OllamaError(`ollama did not answer at ${host}:${port} within 20s`);
  }
  return { base, proc };
}

// Unloads the model (always ours to do) and stops the daemon too if this session started it
// (not if we only attached — Ollama is usually shared infra). `ollama stop` also lets the
// `ollama runner` child reap cleanly, so a later SIGKILL of the daemon doesn't orphan it.
export async function stopOllama(
  handle: OllamaHandle | null,
  model: string,
  onStatus?: (line: string) => void,
): Promise<void> {
  if (!handle) return;
  onStatus?.(`unloading ${model} from ollama…`);
  try {
    const stop = Bun.spawn(["ollama", "stop", model], { stdout: "ignore", stderr: "ignore" });
    const code = await stop.exited;
    onStatus?.(code === 0 ? `${model} unloaded — memory freed` : `${model} wasn't loaded, nothing to free`);
  } catch {
    // best-effort — fall through and stop the daemon regardless
  }
  if (!handle.proc || handle.proc.exitCode !== null) return;
  handle.proc.kill("SIGTERM");
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000));
  const race = await Promise.race([handle.proc.exited.then(() => "exited" as const), timeout]);
  if (race === "timeout" && handle.proc.exitCode === null) handle.proc.kill("SIGKILL");
}

// Synchronous best-effort teardown for 'exit'/uncaughtException: SIGTERM the daemon if we own
// it, and sweep for an orphaned runner by model name regardless, since there's no time to await.
export function stopOllamaSync(handle: OllamaHandle | null, model: string): void {
  if (!handle) return;
  try {
    if (handle.proc && handle.proc.exitCode === null) handle.proc.kill("SIGTERM");
    Bun.spawnSync(["pkill", "-f", `ollama runner .*--model ${model}`], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // best-effort only — never let cleanup crash the exit path
  }
}
