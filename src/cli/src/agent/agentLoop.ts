// The agent loop: send messages + tool specs to the model, run requested tools (confirming
// writes/bash first), feed results back, repeat until done or the round cap hits. UI-agnostic.

import { agentTurn, ChatStreamError, type ChatMessage } from "../chat/chat";
import { TOOL_SPECS, TOOL_BY_NAME, ToolError } from "./tools";

export type AgentEvent =
  | { type: "assistant"; text: string } // model's prose for a turn
  | { type: "action"; text: string } // a tool call + its outcome, one line
  | { type: "status"; text: string }; // transient (“thinking…”, “running bash…”)

export interface RunAgentOpts {
  base: string;
  model?: string; // undefined → server default
  root: string;
  task: string;
  history: ChatMessage[]; // prior turns; system prompt prepended if absent
  signal?: AbortSignal;
  maxRounds?: number;
  onEvent: (e: AgentEvent) => void;
  confirm: (summary: string) => Promise<boolean>; // true to run a needs-confirm tool
}

export class AgentAborted extends Error {}

function systemPrompt(root: string): ChatMessage {
  return {
    role: "system",
    content:
      "You are a coding agent working inside a single project directory: " +
      `${root}\n\n` +
      "You have tools: read_file, list_dir, write_file, bash. All paths are " +
      "relative to that directory and you cannot act outside it. Work in small " +
      "steps: inspect with read_file/list_dir before editing, make focused " +
      "write_file changes, and use bash to build or test. write_file and bash " +
      "require the user's approval each time, so keep those calls purposeful. " +
      "For bug fixes: read the relevant code and reproduce the failure with " +
      "bash before changing anything, make the smallest fix that addresses the " +
      "cause, then re-run the failing command to verify. For writing docs " +
      "(README, guides, markdown): read the code or files the doc describes " +
      "first so it states facts, not guesses; no build step is needed. " +
      "When the task is done, reply with a short plain-text summary and no " +
      "further tool calls. Be concise.",
  };
}

// Runs to completion (or round cap). Throws AgentAborted on abort, or ChatStreamError on
// server failure — callers keep the session alive.
export async function runAgent(opts: RunAgentOpts): Promise<{ messages: ChatMessage[]; finalText: string }> {
  const { base, model, root, task, signal, onEvent, confirm } = opts;
  const maxRounds = opts.maxRounds ?? 12;

  const messages: ChatMessage[] = opts.history.some((m) => m.role === "system")
    ? [...opts.history]
    : [systemPrompt(root), ...opts.history];
  messages.push({ role: "user", content: task });

  let finalText = "";
  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) throw new AgentAborted();
    onEvent({ type: "status", text: "thinking…" });

    let turn;
    try {
      turn = await agentTurn({ base, model, messages, tools: TOOL_SPECS, signal });
    } catch (err) {
      if (err instanceof ChatStreamError && err.message === "cancelled") throw new AgentAborted();
      throw err;
    }

    // Exactly as sent, so follow-up tool messages match by id.
    messages.push({
      role: "assistant",
      content: turn.content,
      ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls } : {}),
    });
    if (turn.content.trim()) onEvent({ type: "assistant", text: turn.content.trim() });

    if (turn.toolCalls.length === 0) {
      finalText = turn.content.trim();
      return { messages, finalText };
    }

    for (const call of turn.toolCalls) {
      if (signal?.aborted) throw new AgentAborted();
      const tool = TOOL_BY_NAME[call.function.name];
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        // leave args empty; the tool reports the missing field and the model can retry
      }

      if (!tool) {
        onEvent({ type: "action", text: `✗ unknown tool ${call.function.name}` });
        messages.push({ role: "tool", tool_call_id: call.id, content: `error: no such tool '${call.function.name}'` });
        continue;
      }

      const summary = tool.summarize(args);
      if (tool.needsConfirm) {
        const ok = await confirm(summary);
        if (!ok) {
          onEvent({ type: "action", text: `✗ skipped ${summary}` });
          messages.push({ role: "tool", tool_call_id: call.id, content: "the user declined to run this; do not retry it" });
          continue;
        }
      }

      onEvent({ type: "status", text: `${summary}…` });
      let result: string;
      try {
        result = await tool.run(args, { root });
        onEvent({ type: "action", text: `✓ ${summary}` });
      } catch (err) {
        const msg = err instanceof ToolError ? err.message : String((err as Error)?.message ?? err);
        result = `error: ${msg}`;
        onEvent({ type: "action", text: `✗ ${summary} — ${msg}` });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  finalText = `stopped after ${maxRounds} tool rounds without finishing — send another message to continue`;
  messages.push({ role: "assistant", content: finalText }); // so a follow-up reads coherently
  onEvent({ type: "assistant", text: finalText });
  return { messages, finalText };
}
