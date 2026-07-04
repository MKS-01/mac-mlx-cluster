import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { Session } from "./cluster";
import type { ClusterConfig } from "./config";
import { streamChat, ChatStreamError, type ChatMessage } from "./chat";
import { switchModel } from "./switchModel";
import { fetchNodeStats, combineStats, type NodeStats } from "./macmon";
import { loadPrefs, savePrefs } from "./prefs";
import { DIM } from "./theme";
import { Header } from "./components/Header";
import { StatsBar } from "./components/StatsBar";
import { ChatView } from "./components/ChatView";
import { HelpView } from "./components/HelpView";
import { InputBar } from "./components/InputBar";

interface State {
  session: Session;
  history: ChatMessage[];
  streaming: string | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  showHelp: boolean;
  statsView: "combined" | "split";
  nodes: NodeStats[];
  quitting: boolean;
}

type Action =
  | { type: "submitUser"; text: string }
  | { type: "token"; chunk: string }
  | { type: "done"; reply: string }
  | { type: "error"; message: string }
  | { type: "notice"; text: string | null }
  | { type: "toggleHelp" }
  | { type: "clear" }
  | { type: "setStatsView"; view: "combined" | "split" }
  | { type: "stats"; nodes: NodeStats[] }
  | { type: "modelSwitched"; session: Session }
  | { type: "quitting" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "submitUser":
      return {
        ...state,
        history: [...state.history, { role: "user", content: action.text }],
        streaming: "",
        busy: true,
        error: null,
        notice: null,
      };
    case "token":
      return { ...state, streaming: (state.streaming ?? "") + action.chunk };
    case "done":
      return {
        ...state,
        history: [...state.history, { role: "assistant", content: action.reply }],
        streaming: null,
        busy: false,
      };
    case "error":
      return { ...state, streaming: null, busy: false, error: action.message };
    case "notice":
      return { ...state, notice: action.text, error: null };
    case "toggleHelp":
      return { ...state, showHelp: !state.showHelp, notice: null, error: null };
    case "clear":
      return { ...state, history: [], streaming: null, error: null, notice: "transcript cleared" };
    case "setStatsView":
      return { ...state, statsView: action.view };
    case "stats":
      return { ...state, nodes: action.nodes };
    case "modelSwitched":
      return { ...state, session: action.session, busy: false };
    case "quitting":
      return { ...state, quitting: true };
  }
}

export function App({
  config,
  session: initialSession,
  onQuit,
}: {
  config: ClusterConfig;
  session: Session;
  onQuit: () => Promise<void>;
}) {
  const { exit } = useApp();
  const prefs = loadPrefs();

  const [state, dispatch] = useReducer(reducer, {
    session: initialSession,
    history: [],
    streaming: null,
    busy: false,
    error: null,
    notice: null,
    showHelp: false,
    statsView: prefs.statsView ?? "combined",
    nodes: [],
    quitting: false,
  });

  const stateRef = useRef(state);
  stateRef.current = state;
  const abortRef = useRef<AbortController | null>(null);

  // Stats polling — both nodes independently, one always-local (self, via
  // whichever IP is "self" in local mode) or both remote (cluster mode).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const [serverStats, peerStats] = await Promise.all([
        fetchNodeStats(config.server.id, config.server.ip, config.server.macmonPort),
        fetchNodeStats(config.peer.id, config.peer.ip, config.peer.macmonPort),
      ]);
      if (!cancelled) dispatch({ type: "stats", nodes: [serverStats, peerStats] });
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const startQuit = () => {
    dispatch({ type: "quitting" });
    abortRef.current?.abort();
    // onQuit may need to SSH bootout a server this session started (see
    // cluster.ts) — that can take a few seconds, so the "quitting…" spinner
    // stays up for the real duration instead of a fixed timeout.
    onQuit().finally(() => {
      exit();
      process.exit(0);
    });
  };

  useInput((input, key) => {
    if (key.escape && state.busy) {
      abortRef.current?.abort();
    }
  });

  const runChat = async (text: string) => {
    dispatch({ type: "submitUser", text });
    const controller = new AbortController();
    abortRef.current = controller;
    const messages: ChatMessage[] = [...stateRef.current.history, { role: "user", content: text }];
    try {
      const reply = await streamChat({
        base: state.session.base,
        messages,
        signal: controller.signal,
        onToken: (chunk) => dispatch({ type: "token", chunk }),
      });
      dispatch({ type: "done", reply });
    } catch (err) {
      if (err instanceof ChatStreamError && err.message === "cancelled") {
        dispatch({ type: "done", reply: stateRef.current.streaming ?? "" });
        dispatch({ type: "notice", text: "cancelled" });
        return;
      }
      dispatch({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      abortRef.current = null;
    }
  };

  const handleModelSwitch = async (arg: string | undefined) => {
    if (!arg) {
      dispatch({ type: "notice", text: `model is ${state.session.model} — /model <repo> to switch` });
      return;
    }
    dispatch({ type: "notice", text: `switching model to ${arg}…` });
    const result = await switchModel(config, state.session, arg, (line) =>
      dispatch({ type: "notice", text: line }),
    );
    if (result.ok && result.session) {
      dispatch({ type: "modelSwitched", session: result.session });
      savePrefs({ model: result.session.model, statsView: stateRef.current.statsView });
      dispatch({ type: "notice", text: result.message });
    } else {
      dispatch({ type: "error", message: result.message });
    }
  };

  const handleCommand = (raw: string) => {
    const [cmd, ...rest] = raw.slice(1).split(/\s+/);
    const arg = rest.join(" ") || undefined;
    switch (cmd) {
      case "help":
        dispatch({ type: "toggleHelp" });
        break;
      case "quit":
      case "exit":
        startQuit();
        break;
      case "model":
        handleModelSwitch(arg);
        break;
      case "stats": {
        const next = state.statsView === "combined" ? "split" : "combined";
        dispatch({ type: "setStatsView", view: next });
        savePrefs({ model: state.session.model, statsView: next });
        break;
      }
      case "clear":
        dispatch({ type: "clear" });
        break;
      default:
        dispatch({ type: "error", message: `unknown command /${cmd} — /help` });
    }
  };

  const handleSubmit = (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    if (value === "q") {
      startQuit();
      return;
    }
    if (value.startsWith("/")) {
      handleCommand(value);
      return;
    }
    runChat(value);
  };

  const combined = combineStats(state.nodes);

  if (state.quitting) {
    return (
      <Box paddingX={1} marginY={1}>
        <Text color={DIM}>quitting…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Header mode={state.session.mode} model={state.session.model} />
      <Box marginTop={1} marginBottom={1}>
        <StatsBar view={state.statsView} nodes={state.nodes} combined={combined} />
      </Box>

      {state.showHelp && <HelpView />}
      {state.notice && (
        <Box marginBottom={1}>
          <Text color={DIM}>{state.notice}</Text>
        </Box>
      )}

      <ChatView history={state.history} streaming={state.streaming} error={state.error} />

      <InputBar disabled={state.busy} onSubmit={handleSubmit} />
    </Box>
  );
}
