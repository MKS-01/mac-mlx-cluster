// Streaming client for an OpenAI-compatible /v1/chat/completions endpoint —
// same protocol as tools/chat.py, adapted to fetch's ReadableStream so it
// can drive an Ink UI incrementally instead of printing to stdout.

// "tool" is the OpenAI role for a tool's result; "action" is display-only —
// it never goes to the server, only into the transcript to show what the
// agent did (see src/agent/agentLoop.ts and ChatView.tsx). tool_calls /
// tool_call_id are the OpenAI tool-calling fields, present only on the
// assistant turn that requests tools and the tool messages that answer them.
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

/**
 * One non-streaming tool-aware turn against /v1/chat/completions. The agent
 * loop (src/agent/agentLoop.ts) drives this repeatedly: send the running
 * message list + tool specs, get back either final text or tool calls to
 * execute. Non-streaming on purpose — accumulating streamed tool_call deltas
 * is fiddly and error-prone with 4-bit local models, and the loop already
 * breaks the interaction into discrete tool steps, so there's no live-typing
 * UX to preserve within a turn. Throws ChatStreamError (display-ready) on any
 * failure, same contract as streamChat.
 */
export async function agentTurn(opts: {
  base: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  // Repo id sent as `model` so mlx_lm.server serves/loads it from the shared
  // cache — lets the agent use its own (lighter, MoE) model regardless of
  // what the chat session is serving. Omitted → the server's loaded model.
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

export class ChatStreamError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}

export interface StreamChatOptions {
  base: string;
  messages: ChatMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
  onToken: (chunk: string) => void;
  /** per-read idle timeout in ms — guards against a hung connection that never closes */
  idleTimeoutMs?: number;
}

/**
 * Streams a chat completion, calling onToken per delta. Resolves with the
 * full assistant reply. Throws ChatStreamError on any failure (network,
 * non-2xx, malformed SSE, idle timeout, or abort) with a message suitable
 * for direct display — callers should catch this and keep the session alive
 * rather than crashing.
 */
export async function streamChat(opts: StreamChatOptions): Promise<string> {
  const { base, messages, maxTokens = 2048, signal, onToken, idleTimeoutMs = 60_000 } = opts;

  let res: Response;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, max_tokens: maxTokens, stream: true }),
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
  // Reasoning models (e.g. Qwen3.6's thinking mode) stream their internal
  // reasoning under delta.reasoning, separate from delta.content — mlx_lm.
  // server counts both against max_tokens, so a verbose thinking pass can
  // exhaust the whole budget before any content is ever emitted. Track
  // whether that happened so it surfaces as a clear error instead of a
  // silently empty reply.
  let sawReasoning = false;
  let finishReason: string | null = null;

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
        const choice = parsed?.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (choice?.delta?.reasoning) sawReasoning = true;
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
