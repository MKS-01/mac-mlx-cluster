// Streaming client for an OpenAI-compatible /v1/chat/completions endpoint.

// "action" is display-only — never sent to the server, just shown in the transcript.
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "action";
  content: string;
  tool_calls?: ApiToolCall[];
  tool_call_id?: string;
}

export interface ApiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** An OpenAI-style tool/function definition sent in the request's `tools`. */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentTurnResult {
  /** Assistant text for this turn (may be empty when it only calls tools). */
  content: string;
  /** Tool calls the model wants run before it continues, if any. */
  toolCalls: ApiToolCall[];
  finishReason: string | null;
}

// One non-streaming tool-aware turn. Non-streaming on purpose: accumulating streamed
// tool_call deltas is fiddly with 4-bit local models, and there's no live-typing UX to preserve.
export async function agentTurn(opts: {
  base: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  // Lets the agent use its own model regardless of what the chat session is serving.
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<AgentTurnResult> {
  const { base, messages, tools, model, maxTokens = 4096, signal } = opts;
  let res: Response;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(model ? { model } : {}), messages, tools, max_tokens: maxTokens, stream: false }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new ChatStreamError("cancelled", err);
    throw new ChatStreamError(`could not reach server at ${base} — is it still up?`, err);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      // body may already be consumed
    }
    throw new ChatStreamError(`server returned ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  let body: any;
  try {
    body = await res.json();
  } catch (err) {
    // An Esc can land while the body is still streaming in, not just during fetch.
    if ((err as Error).name === "AbortError") throw new ChatStreamError("cancelled", err);
    throw new ChatStreamError("server returned a non-JSON response to a tool-calling request", err);
  }
  const choice = body?.choices?.[0];
  const msg = choice?.message ?? {};
  const rawCalls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const toolCalls: ApiToolCall[] = rawCalls.map((c, i) => ({
    id: c?.id || `call_${i}`,
    type: "function",
    function: {
      name: c?.function?.name ?? "",
      arguments: typeof c?.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c?.function?.arguments ?? {}),
    },
  }));
  return {
    content: typeof msg.content === "string" ? msg.content : "",
    toolCalls,
    finishReason: choice?.finish_reason ?? null,
  };
}

// Token accounting for one exchange; server-reported counts, not an estimate from deltas.
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  /** prompt tokens served from the KV cache, when the server reports it */
  cachedTokens: number | null;
  /** generation speed — mlx_vlm reports it directly; otherwise measured here */
  tokensPerSecond: number | null;
  /** wall time from request sent to stream close */
  elapsedMs: number;
}

// One-line transcript summary, e.g. `↑ 412 in · ↓ 128 out · 23.4 tok/s · 5.5s`.
export function formatUsage(u: ChatUsage): string {
  const parts = [
    `↑ ${u.promptTokens} in`,
    `↓ ${u.completionTokens} out`,
  ];
  if (u.cachedTokens) parts.push(`${u.cachedTokens} cached`);
  if (u.tokensPerSecond !== null) parts.push(`${u.tokensPerSecond.toFixed(1)} tok/s`);
  parts.push(`${(u.elapsedMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}

export class ChatStreamError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}

export interface StreamChatOptions {
  base: string;
  messages: ChatMessage[];
  // Optional for mlx_lm.server back-compat; mlx_vlm.server 422s without it, so always pass it.
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  onToken: (chunk: string) => void;
  /** Best-effort: skipped if the server sends no usage chunk. */
  onUsage?: (usage: ChatUsage) => void;
  /** Guards against a hung connection that never closes. */
  idleTimeoutMs?: number;
}

// Throws ChatStreamError (display-ready message) on any failure; callers keep the session alive.
export async function streamChat(opts: StreamChatOptions): Promise<string> {
  const { base, messages, model, maxTokens = 2048, signal, onToken, onUsage, idleTimeoutMs = 60_000 } = opts;
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(model ? { model } : {}),
        messages,
        max_tokens: maxTokens,
        stream: true,
        // Asks for the trailing usage chunk; older servers just ignore the option.
        stream_options: { include_usage: true },
      }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new ChatStreamError("cancelled", err);
    throw new ChatStreamError(`could not reach server at ${base} — is it still up?`, err);
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      // ignore — body may already be consumed/unavailable
    }
    throw new ChatStreamError(`server returned ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  if (!res.body) {
    throw new ChatStreamError("server response had no body (unexpected — not a streaming response?)");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const pieces: string[] = [];
  // Thinking models can exhaust max_tokens on reasoning alone, leaving content empty; track it.
  let sawReasoning = false;
  let finishReason: string | null = null;
  let rawUsage: any = null;
  let serverTps: number | null = null;
  let firstTokenAt: number | null = null;

  const readWithTimeout = async () => {
    const to = setTimeout(() => reader.cancel("idle timeout").catch(() => {}), idleTimeoutMs);
    try {
      return await reader.read();
    } finally {
      clearTimeout(to);
    }
  };

  try {
    while (true) {
      let chunk;
      try {
        chunk = await readWithTimeout();
      } catch (err) {
        if (signal?.aborted) throw new ChatStreamError("cancelled", err);
        throw new ChatStreamError(
          `lost connection mid-stream (server may have crashed) — ${String((err as Error).message ?? err)}`,
          err,
        );
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let parsed: any;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // keep-alive or partial fragment — ignore
        }
        if (parsed?.usage) rawUsage = parsed.usage;
        if (typeof parsed?.timings?.predicted_per_second === "number") {
          serverTps = parsed.timings.predicted_per_second;
        }
        const choice = parsed?.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (choice?.delta?.reasoning) sawReasoning = true;
        // Time from first token of any kind — timing only content deltas inflated tok/s wildly.
        if (firstTokenAt === null && (choice?.delta?.reasoning || choice?.delta?.content)) {
          firstTokenAt = Date.now();
        }
        const delta: string | undefined = choice?.delta?.content;
        if (delta) {
          pieces.push(delta);
          onToken(delta);
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released via cancel() above
    }
  }

  // Reported before the empty-reply check so a budget-exhausted turn still accounts for its tokens.
  if (onUsage && rawUsage && typeof rawUsage.completion_tokens === "number") {
    const completionTokens = rawUsage.completion_tokens;
    const genMs = firstTokenAt === null ? 0 : Date.now() - firstTokenAt;
    onUsage({
      promptTokens: rawUsage.prompt_tokens ?? 0,
      completionTokens,
      cachedTokens: rawUsage.prompt_tokens_details?.cached_tokens ?? null,
      tokensPerSecond: serverTps ?? (genMs > 0 ? (completionTokens / genMs) * 1000 : null),
      elapsedMs: Date.now() - startedAt,
    });
  }

  const reply = pieces.join("");
  if (!reply) {
    if (sawReasoning && finishReason === "length") {
      throw new ChatStreamError(
        `model spent its whole token budget thinking and never got to an answer (max_tokens=${maxTokens}) — try again, or ask something it needs to think less about`,
      );
    }
    throw new ChatStreamError("model returned an empty reply — try again");
  }
  return reply;
}
