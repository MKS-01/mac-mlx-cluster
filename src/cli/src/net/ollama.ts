// Ollama as a serving backend. Ollama ships its own MLX runner and exposes an
// OpenAI-compatible API (/v1/models, /v1/chat/completions), which is exactly
// the protocol this CLI already speaks — so its `-mlx` models are reachable
// without importing or converting anything. That matters because Ollama keeps
// its own model store: models pulled there would otherwise have to be
// downloaded a second time into the HF cache to be usable here.
//
// Two shapes Ollama does NOT provide, both already handled as fallbacks by
// chat.ts: no `prompt_tokens_details` (so the usage line shows no "cached"
// figure) and no `timings` block (so tok/s is measured client-side).

import { checkHealth, pollUntilHealthy } from "./server";
import type { CachedModel } from "../models/models";

export interface OllamaHandle {
  base: string;
  /** Set only when THIS session spawned the daemon — see ensureOllama. */
  proc: ReturnType<typeof Bun.spawn> | null;
}

export class OllamaError extends Error {}

/**
 * Session `base` for Ollama. Deliberately WITHOUT the `/v1` suffix: every
 * consumer (checkHealth, streamChat, agentTurn) appends `/v1/...` itself, so
 * including it here yields `/v1/v1/chat/completions` and a 404.
 */
export function ollamaBase(host: string, port: number): string {
  return `http://${host}:${port}`;
}

/** True if a daemon is already answering. */
export async function isOllamaUp(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return checkHealth(ollamaBase(host, port), timeoutMs);
}

/**
 * Models Ollama has locally, via its native /api/tags (the OpenAI /v1/models
 * route omits sizes). Shaped as CachedModel so `/model` can render and
 * resolve Ollama models through exactly the same path as HF-cached ones.
 */
export async function listOllamaModels(host: string, port: number): Promise<CachedModel[]> {
  const res = await fetch(`http://${host}:${port}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new OllamaError(`ollama /api/tags returned ${res.status}`);
  const data = (await res.json()) as { models?: { name: string; size: number }[] };
  return (data.models ?? [])
    .map((m) => ({ repo: m.name, sizeGB: (m.size ?? 0) / 1024 ** 3 }))
    .sort((a, b) => b.sizeGB - a.sizeGB);
}

/**
 * Attach to a running daemon, or start one. Ownership follows the same rule as
 * the server node's LaunchAgent (cluster.ts): a daemon we didn't start is not
 * ours to stop — Ollama is usually long-running shared infrastructure, and
 * killing it on quit would take down the user's other clients. `proc` is null
 * in the attach case so stopOllama() is a no-op there.
 */
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
  // Health-poll rather than trusting the spawn: `ollama serve` exits
  // immediately when a daemon is already bound to the port, which would
  // otherwise look like a failure when in fact we can just attach.
  if (!(await pollUntilHealthy(host, port, 20_000))) {
    proc.kill("SIGKILL");
    throw new OllamaError(`ollama did not answer at ${host}:${port} within 20s`);
  }
  return { base, proc };
}

/** Only stops a daemon this session started (see ensureOllama). */
export function stopOllama(handle: OllamaHandle | null): void {
  if (!handle?.proc || handle.proc.exitCode !== null) return;
  handle.proc.kill("SIGKILL");
}
