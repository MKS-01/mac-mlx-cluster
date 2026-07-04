// Streaming client for an OpenAI-compatible /v1/chat/completions endpoint —
// same protocol as cluster/chat.py, adapted to fetch's ReadableStream so it
// can drive an Ink UI incrementally instead of printing to stdout.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
