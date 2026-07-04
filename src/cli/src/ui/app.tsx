import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { startSolo, startCluster, stopCurrentSession, type Session } from "../cluster/cluster";
import type { ClusterConfig } from "../config/config";
import { streamChat, ChatStreamError, type ChatMessage } from "../chat/chat";
import { switchModel } from "../models/switchModel";
import { listServerModels, resolveModel, type CachedModel } from "../models/models";
import { fetchNodeStats, combineStats, selfNodeId, type NodeStats } from "../net/macmon";
import { loadPrefs, savePrefs } from "../config/prefs";
import { actualPct, formatSplit, parseSplit, type SplitTarget } from "../cluster/splitPolicy";
import { estimatedCeilingGB, fitVerdict } from "../cluster/memory";
import { windowMessages, estimateLines } from "../chat/chatWindow";
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
const HELP_LINES = 12; // HelpView.tsx rows + its marginBottom
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
  splitTarget: SplitTarget;
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
  | { type: "setSplitTarget"; target: SplitTarget }
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
    case "setSplitTarget":
      return { ...state, splitTarget: action.target };
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
  onActiveTime,
}: {
  config: ClusterConfig;
  session: Session;
  onQuit: () => Promise<void>;
  // Reports wall-clock ms spent actually generating (not idle between
  // messages) after each exchange, so index.tsx can credit it to whichever
  // node served this session for the wear-leveling split (splitPolicy.ts).
  onActiveTime?: (deltaMs: number) => void;
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
    splitTarget: prefs.splitTarget,
    nodes: [],
    quitting: false,
  });

  const stateRef = useRef(state);
  stateRef.current = state;
  const abortRef = useRef<AbortController | null>(null);

  // Stats polling — both nodes independently. The node this CLI runs on
  // falls back to loopback if its bridge IP doesn't answer, so a solo
  // (bridge-less) session still shows this Mac's memory instead of two
  // "unavailable" rows.
  useEffect(() => {
    const selfId = selfNodeId(config.server, config.peer);
    let cancelled = false;
    const tick = async () => {
      const [serverStats, peerStats] = await Promise.all([
        fetchNodeStats(config.server.id, config.server.ip, config.server.macmonPort, config.server.id === selfId),
        fetchNodeStats(config.peer.id, config.peer.ip, config.peer.macmonPort, config.peer.id === selfId),
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
    // Wall time of the whole exchange (prompt processing + generation) is
    // the proxy for actual GPU load this session put on whichever node
    // served it — idle time waiting for the next message doesn't count.
    const startedAt = Date.now();
    try {
      const reply = await streamChat({
        base: state.session.base,
        messages,
        signal: controller.signal,
        onToken: (chunk) => dispatch({ type: "token", chunk }),
      });
      onActiveTime?.(Date.now() - startedAt);
      dispatch({ type: "done", reply });
    } catch (err) {
      onActiveTime?.(Date.now() - startedAt);
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
    // local mode reads this Mac's cache; cluster and shard both read the
    // server node's over SSH (in shard mode every node must have the model,
    // and the server node is the one we can't see locally).
    const cacheNode = session.mode === "local" ? "this Mac" : config.server.id;
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

    // Pre-flight the wired-memory fit on the node that would serve (shard
    // mode aggregates both nodes, so only whole-model modes are gated) —
    // kickstarting a server with a model past its ceiling just times out
    // vaguely 60s later, so refuse up front with the actionable answer.
    if (session.mode !== "shard" && listRes.ok) {
      const sizeGB = listRes.models.find((m) => m.repo === target)?.sizeGB;
      const node = session.mode === "cluster" ? stateRef.current.nodes[0] : stateRef.current.nodes[1];
      const ramGB = node?.snapshot ? node.snapshot.memory.ram_total / 1024 ** 3 : null;
      if (sizeGB !== undefined && ramGB !== null) {
        const verdict = fitVerdict(sizeGB, ramGB);
        if (verdict === "exceeds") {
          dispatch({
            type: "error",
            message:
              `${target} (${sizeGB.toFixed(1)} GB) likely exceeds ${cacheNode}'s wired-memory ceiling ` +
              `(~${estimatedCeilingGB(ramGB).toFixed(0)} of ${ramGB.toFixed(0)} GB) — ` +
              `shard it with /mode cluster, or pick a smaller quant`,
          });
          return;
        }
        if (verdict === "tight") {
          dispatch({
            type: "notice",
            text: `${target} is close to ${cacheNode}'s wired-memory ceiling — expect mlx-lm's slow-generation warning`,
          });
        }
      }
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
      savePrefs({
        model: result.session.model,
        statsView: stateRef.current.statsView,
        splitTarget: stateRef.current.splitTarget,
        splitHistory: prefs.splitHistory,
      });
      dispatch({ type: "notice", text: result.message });
    } else {
      dispatch({ type: "error", message: result.message });
    }
  };

  // /split — no arg shows the current target + actual share so far; with an
  // arg (e.g. "60/40") sets a new target, effective from the *next* session
  // (this session already committed to whichever node connect() picked).
  const handleSplit = (arg: string | undefined) => {
    if (!arg) {
      const pct = actualPct(prefs.splitHistory);
      dispatch({
        type: "notice",
        text:
          `split target ${formatSplit(stateRef.current.splitTarget)} (${config.server.id}/${config.peer.id}) ` +
          `· actual so far ${pct.server}/${pct.peer} (active-generation time)`,
      });
      return;
    }
    const parsed = parseSplit(arg);
    if (!parsed) {
      dispatch({ type: "error", message: `invalid split "${arg}" — use e.g. /split 60/40 (must sum to 100)` });
      return;
    }
    dispatch({ type: "setSplitTarget", target: parsed });
    savePrefs({
      model: stateRef.current.session.model,
      statsView: stateRef.current.statsView,
      splitTarget: parsed,
      splitHistory: prefs.splitHistory,
    });
    dispatch({ type: "notice", text: `split target set to ${formatSplit(parsed)} — applies from your next session` });
  };

  // Plain-language description of how the model is currently being served —
  // used by /mode's notices so the copy stays node-name-agnostic.
  const describeMode = (s: Session): string => {
    if (s.mode === "shard") return "cluster — sharded across all nodes";
    if (s.mode === "cluster") return `server — ${config.server.id} serves the whole model`;
    return "solo — this Mac serves the whole model";
  };

  // Shared teardown-then-start path for /mode switches: stops whatever the
  // current session is serving through, starts the replacement, and swaps
  // the session via the same dispatch /model switching uses. The obligation
  // to restore the server node's LaunchAgent on quit (tookOverFromServer)
  // carries forward across switches — the new session may not have stopped
  // it itself, but *somebody* this process spawned did.
  const replaceSession = async (
    prev: Session,
    model: string,
    start: (cfg: ClusterConfig, model: string, onStatus: (line: string) => void) => Promise<Session>,
  ) => {
    dispatch({ type: "modelList", list: null });
    dispatch({ type: "switching", on: true });
    try {
      await stopCurrentSession(config, prev);
      const next = await start(config, model, (line) => dispatch({ type: "notice", text: line }));
      const merged = { ...next, tookOverFromServer: next.tookOverFromServer || prev.tookOverFromServer };
      dispatch({ type: "modelSwitched", session: merged });
      savePrefs({
        model: merged.model,
        statsView: stateRef.current.statsView,
        splitTarget: stateRef.current.splitTarget,
        splitHistory: prefs.splitHistory,
      });
      dispatch({ type: "notice", text: `${describeMode(merged)} · serving ${merged.model}` });
    } catch (err) {
      dispatch({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      dispatch({ type: "switching", on: false });
    }
  };

  // /mode — show or change how the model is served: solo (whole model on
  // this Mac, server node freed) or cluster (tensor-parallel sharded across
  // every node in the hostfile, for models too big for one machine).
  const handleMode = async (arg: string | undefined) => {
    const session = stateRef.current.session;
    const [sub, ...rest] = (arg ?? "").split(/\s+/).filter(Boolean);
    const modelArg = rest.join(" ") || undefined;

    if (!sub) {
      dispatch({ type: "notice", text: `mode: ${describeMode(session)} · /mode solo | /mode cluster [<model>]` });
      return;
    }
    if (sub === "solo") {
      if (session.mode === "local") {
        dispatch({ type: "notice", text: "already solo — this Mac is serving" });
        return;
      }
      await replaceSession(session, session.model, startSolo);
      return;
    }
    if (sub !== "cluster") {
      dispatch({ type: "error", message: `unknown mode "${sub}" — /mode solo | /mode cluster [<model>]` });
      return;
    }

    // cluster: resolve an optional model arg against the serving node's
    // cache (same substring resolution as /model); an unresolved arg falls
    // through as typed — startCluster's every-node cache check is the real
    // gate and names whichever node is missing it.
    let target = session.model;
    if (modelArg) {
      const listRes = await listServerModels(config, session);
      if (listRes.ok) {
        const resolved = resolveModel(modelArg, listRes.models);
        if (resolved.kind === "ambiguous") {
          dispatch({ type: "error", message: `"${modelArg}" matches: ${resolved.repos.join(", ")} — be more specific` });
          return;
        }
        target = resolved.kind === "match" ? resolved.repo : modelArg;
      } else {
        target = modelArg;
      }
    }
    if (session.mode === "shard" && target === session.model) {
      dispatch({ type: "notice", text: `already sharded across the cluster, serving ${target}` });
      return;
    }
    await replaceSession(session, target, startCluster);
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
        savePrefs({
          model: state.session.model,
          statsView: next,
          splitTarget: state.splitTarget,
          splitHistory: prefs.splitHistory,
        });
        break;
      }
      case "split":
        handleSplit(arg);
        break;
      case "mode":
        handleMode(arg);
        break;
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
          nodeId={state.session.mode === "local" ? "this Mac" : config.server.id}
          // fit is judged against the RAM of whichever node(s) serve: nodes
          // is [server, peer]; in local mode "this Mac" is the peer (the dev
          // machine serving itself), and shard mode aggregates both nodes'
          // memory (that's the whole point of sharding).
          ramGB={(() => {
            if (state.session.mode === "shard") {
              const total = state.nodes.reduce(
                (sum, n) => sum + (n?.snapshot ? n.snapshot.memory.ram_total / 1024 ** 3 : 0),
                0,
              );
              return total > 0 ? total : null;
            }
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
        busyText={state.switching ? "switching — serving is restarting… (big models can take a while)" : undefined}
        onSubmit={handleSubmit}
      />
    </Box>
  );
}
