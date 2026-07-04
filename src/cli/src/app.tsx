import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { Session } from "./cluster";
import type { ClusterConfig } from "./config";
import { streamChat, ChatStreamError, type ChatMessage } from "./chat";
import { switchModel } from "./switchModel";
import { listServerModels, resolveModel, type CachedModel } from "./models";
import { fetchNodeStats, combineStats, type NodeStats } from "./macmon";
import { loadPrefs, savePrefs } from "./prefs";
import { windowMessages, estimateLines } from "./chatWindow";
import { DIM } from "./theme";
import { Header } from "./components/Header";
import { StatusPanel } from "./components/StatusPanel";
import { ChatView } from "./components/ChatView";
import { HelpView } from "./components/HelpView";
import { ModelListView } from "./components/ModelListView";
import { InputBar } from "./components/InputBar";

const HEADER_LINES = 5; // Header.tsx: 2 wordmark rows, marginTop, version, hint
const PANEL_FIXED_LINES = 2; // StatusPanel model + server rows (memory rows counted per view)
const INPUT_LINES = 3; // InputBar's round border adds a row above and below
const HELP_LINES = 7; // HelpView.tsx rows + its marginBottom
const PADDING_LINES = 2; // App's paddingY={1} top+bottom
const SAFETY_MARGIN = 1; // avoid the very last row (some terminals clip it)

interface State {
  session: Session;
  history: ChatMessage[];
  streaming: string | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  showHelp: boolean;
  modelList: CachedModel[] | null;
  switching: boolean;
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
  | { type: "modelList"; list: CachedModel[] | null }
  | { type: "switching"; on: boolean }
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
        modelList: null,
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
      return { ...state, showHelp: !state.showHelp, notice: null, error: null, modelList: null };
    case "modelList":
      return { ...state, modelList: action.list, showHelp: false, error: null };
    case "switching":
      return { ...state, switching: action.on };
    case "clear":
      return { ...state, history: [], streaming: null, error: null, notice: "transcript cleared", modelList: null };
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
  const { stdout } = useStdout();
  const prefs = loadPrefs();

  const [state, dispatch] = useReducer(reducer, {
    session: initialSession,
    history: [],
    streaming: null,
    busy: false,
    error: null,
    notice: null,
    showHelp: false,
    modelList: null,
    switching: false,
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

  // /model — list what's cached on the serving node; /model <arg> — resolve
  // arg against that cache (mlxctl-style substring) and switch. The cache is
  // the gate on purpose: the server runs with HF_HUB_OFFLINE=1, so switching
  // to an uncached repo would just break it on restart.
  const handleModelSwitch = async (arg: string | undefined) => {
    const session = stateRef.current.session;
    const cacheNode = session.mode === "cluster" ? config.server.id : "this Mac";
    dispatch({ type: "notice", text: `reading model cache on ${cacheNode}…` });
    const listRes = await listServerModels(config, session);

    if (!arg) {
      if (!listRes.ok) {
        dispatch({ type: "error", message: listRes.message });
        return;
      }
      dispatch({ type: "modelList", list: listRes.models });
      dispatch({ type: "notice", text: null });
      return;
    }

    let target = arg;
    if (listRes.ok) {
      const resolved = resolveModel(arg, listRes.models);
      if (resolved.kind === "none") {
        dispatch({
          type: "error",
          message: `no cached model on ${cacheNode} matches "${arg}" — /model to list, or download it there first`,
        });
        return;
      }
      if (resolved.kind === "ambiguous") {
        dispatch({ type: "error", message: `"${arg}" matches: ${resolved.repos.join(", ")} — be more specific` });
        return;
      }
      target = resolved.repo;
    }
    // cache unreadable (listRes not ok): fall through with arg as typed
    // rather than blocking the switch on a stats-style nicety.

    if (target === session.model) {
      dispatch({ type: "notice", text: `already serving ${target}` });
      return;
    }

    dispatch({ type: "modelList", list: null });
    dispatch({ type: "switching", on: true });
    dispatch({ type: "notice", text: `switching model to ${target}…` });
    const result = await switchModel(config, session, target, (line) =>
      dispatch({ type: "notice", text: line }),
    );
    dispatch({ type: "switching", on: false });
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

  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  // StatusPanel height: fixed model+server rows, plus 1 memory line combined
  // or 1 per node in split view, plus its marginTop/marginBottom box (+2).
  // Recomputed every render (stats poll, keystroke, token) so the budget
  // always matches the current view.
  const panelLines =
    PANEL_FIXED_LINES + (state.statsView === "combined" ? 1 : Math.max(1, state.nodes.length)) + 2;
  // ModelListView: heading + one row per model + hint + marginBottom (or the
  // 2-line empty-cache message).
  const modelListLines =
    state.modelList === null ? 0 : state.modelList.length === 0 ? 2 : state.modelList.length + 3;
  const reserved =
    HEADER_LINES +
    panelLines +
    (state.showHelp ? HELP_LINES : 0) +
    modelListLines +
    (state.notice ? 1 : 0) +
    INPUT_LINES +
    PADDING_LINES +
    SAFETY_MARGIN;
  const chatBudget = Math.max(3, rows - reserved);
  const streamingLines = state.streaming !== null ? estimateLines(state.streaming, columns) + 1 : 0;
  const { visible, hiddenCount } = windowMessages(state.history, columns, Math.max(1, chatBudget - streamingLines));

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Header />
      <Box marginTop={1} marginBottom={1}>
        <StatusPanel session={state.session} view={state.statsView} nodes={state.nodes} combined={combined} />
      </Box>

      {state.showHelp && <HelpView />}
      {state.modelList !== null && (
        <ModelListView
          models={state.modelList}
          current={state.session.model}
          nodeId={state.session.mode === "cluster" ? config.server.id : "this Mac"}
          // fit is judged against the RAM of whichever node serves: nodes is
          // [server, peer], and in local mode "this Mac" is the peer (the
          // dev machine falls back to serving itself).
          ramGB={(() => {
            const n = state.session.mode === "cluster" ? state.nodes[0] : state.nodes[1];
            return n?.snapshot ? n.snapshot.memory.ram_total / 1024 ** 3 : null;
          })()}
        />
      )}
      {state.notice && (
        <Box marginBottom={1}>
          <Text color={DIM}>{state.notice}</Text>
        </Box>
      )}

      <ChatView visible={visible} hiddenCount={hiddenCount} streaming={state.streaming} error={state.error} />

      <InputBar
        disabled={state.busy || state.switching}
        busyText={state.switching ? "switching model… (a few seconds of downtime)" : undefined}
        onSubmit={handleSubmit}
      />
    </Box>
  );
}
