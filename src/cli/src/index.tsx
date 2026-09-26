import React from "react";
import { render } from "ink";
import { createInterface } from "node:readline/promises";
import { App } from "./ui/app";
import { connect, connectPreferPeer, startOllama, disconnect, disconnectSync, type Session } from "./cluster/cluster";
import { loadConfig, ConfigError, type ClusterConfig } from "./config/config";
import { loadPrefs, savePrefs } from "./config/prefs";
import {
  recommend,
  actualPct,
  formatSplit,
  IDLE_CPU_PCT,
  IDLE_GPU_PCT,
  BUSY_CPU_PCT,
  BUSY_GPU_PCT,
} from "./cluster/splitPolicy";
import { fetchNodeStats, selfNodeId } from "./net/macmon";
import { fitVerdict } from "./cluster/memory";
import { localModelSizeGB } from "./models/models";
import { version } from "../package.json";

// Wear-leveling thresholds (splitPolicy.ts): below IDLE take over silently, at/above
// BUSY back off, the ambiguous gap between is the only case that prompts.

function parseArgs() {
  const args = process.argv.slice(2);
  let model: string | undefined;
  let localPort: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) model = args[++i];
    else if (args[i] === "--local-port" && args[i + 1]) {
      const port = Number(args[++i]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error(red(`invalid --local-port "${args[i]}" — expected 1-65535`));
        process.exit(1);
      }
      localPort = port;
    } else if (args[i] === "--version" || args[i] === "-v") {
      console.log(`mlx-cluster ${version}`);
      process.exit(0);
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(
        [
          "mlx-cluster [--model <repo>] [--local-port <port>] [--version]",
          "",
          "  --model <repo>       start with this model instead of the last-used one",
          "  --local-port <port>  port for a locally spawned server this session (default: config localApiPort)",
          "  --version, -v        print version and exit",
          "  --help, -h           this help — /help inside the app lists the slash commands",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return { model, localPort };
}

const dim = (s: string) => `\x1b[38;2;128;128;128m${s}\x1b[0m`;
const red = (s: string) => `\x1b[38;2;255;93;93m${s}\x1b[0m`;

async function confirmPrompt(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

let session: Session | null = null;
let shutdownDone = false;
// Wall time spent generating, credited to the serving node as the wear-leveling usage metric.
let sessionActiveMs = 0;

let config: ClusterConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error(red(err instanceof ConfigError ? err.message : String(err)));
  process.exit(1);
}

function persistActiveTime(): void {
  if (!session || sessionActiveMs <= 0) return;
  // Reload fresh — /split may have changed the target mid-session.
  const fresh = loadPrefs();
  const minutes = sessionActiveMs / 60000;
  if (session.mode === "cluster") fresh.splitHistory.serverMinutes += minutes;
  else if (session.mode === "shard") {
    // A sharded session works both Macs equally — credit half to each.
    fresh.splitHistory.serverMinutes += minutes / 2;
    fresh.splitHistory.peerMinutes += minutes / 2;
  } else fresh.splitHistory.peerMinutes += minutes;
  savePrefs(fresh);
}

// Normal quit path (Ctrl+C, /quit, SIGTERM) — can await an SSH bootout round trip.
async function shutdown(): Promise<void> {
  if (shutdownDone) return;
  shutdownDone = true;
  persistActiveTime();
  await disconnect(config, session, (line) => console.log(dim(line)));
}

// Sync fallback for paths where Node won't run async work ('exit', uncaught exceptions).
function shutdownSyncFallback(): void {
  if (shutdownDone) return;
  shutdownDone = true;
  try {
    persistActiveTime();
  } catch {
    // best-effort only — never let cleanup crash the exit path
  }
  disconnectSync(config, session);
}

// SIGINT only fires before Ink's raw mode is up; after that App routes Ctrl+C itself.
process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
// Terminal closed / SSH dropped: without a handler the default action skips 'exit' cleanup entirely.
process.on("SIGHUP", async () => {
  try {
    await shutdown();
  } catch {
    // best-effort — the terminal is gone, nowhere to report to
  }
  process.exit(0);
});
process.on("exit", shutdownSyncFallback);
process.on("uncaughtException", (err) => {
  console.error(red(String(err instanceof Error ? err.stack ?? err.message : err)));
  shutdownSyncFallback();
  process.exit(1);
});
// Bun treats these as fatal like uncaughtException; same safety net.
process.on("unhandledRejection", (err) => {
  console.error(red(String(err instanceof Error ? err.stack ?? err.message : err)));
  shutdownSyncFallback();
  process.exit(1);
});

const { model, localPort } = parseArgs();
// Per-session override of config.localApiPort; never affects the remote node.
if (localPort !== undefined) config = { ...config, localApiPort: localPort };
const prefs = loadPrefs();

// Safety net for a remembered Ollama-style name that no HF-cache-backed mode can serve.
if (prefs.backend !== "ollama" && prefs.model && !/^[\w.-]+\/[\w.-]+$/.test(prefs.model)) {
  console.log(
    dim(`remembered model "${prefs.model}" isn't an HF repo id — using ${config.defaultModel}. ` +
      `(/mode ollama to serve ollama's own models.)`),
  );
  prefs.model = null;
}

// Wear-leveling: decide whether to serve from the peer per splitPolicy.ts's recommendation,
// sanity-checked against the peer's actual current load.
let usePeer = config.defaultMode === "solo"; // solo pins serving here; skip the check
if (prefs.backend === "ollama" && !model) usePeer = true; // ollama serves locally regardless
if (!usePeer && recommend(prefs.splitHistory, prefs.splitTarget) === "peer") {
  const pct = actualPct(prefs.splitHistory);
  const splitLine =
    `wear-leveling: actual split ${pct.server}/${pct.peer} vs target ${formatSplit(prefs.splitTarget)} ` +
    `(${config.server.id}/${config.peer.id}) — ${config.peer.id}'s turn to serve.`;

  const peerStats = await fetchNodeStats(
    config.peer.id,
    config.peer.ip,
    config.peer.macmonPort,
    selfNodeId(config.server, config.peer) === config.peer.id,
  );
  const cpuPct = peerStats.snapshot?.cpu_usage_pct ?? 0;
  const gpuPct = peerStats.snapshot?.gpu_usage[1] ?? 0;

  if (cpuPct >= BUSY_CPU_PCT || gpuPct >= BUSY_GPU_PCT) {
    console.log(
      dim(
        `${splitLine} Skipping for now — ${config.peer.id} looks busy with something else ` +
          `(cpu ${(cpuPct * 100).toFixed(0)}%, gpu ${(gpuPct * 100).toFixed(0)}%).`,
      ),
    );
  } else if (cpuPct <= IDLE_CPU_PCT && gpuPct <= IDLE_GPU_PCT) {
    console.log(dim(`${splitLine} ${config.peer.id} is idle — serving locally.`));
    usePeer = true;
  } else {
    console.log(dim(splitLine));
    usePeer = await confirmPrompt(dim(`Serve from ${config.peer.id} for this session? [y/N] `));
  }
}

// Memory-fit override: never point the session at a Mac the model likely can't wire.
{
  const startupModel = model ?? prefs.model ?? config.defaultModel;
  const sizeGB = localModelSizeGB(startupModel);
  if (sizeGB !== null) {
    const selfId = selfNodeId(config.server, config.peer);
    const [srv, peer] = await Promise.all([
      fetchNodeStats(config.server.id, config.server.ip, config.server.macmonPort, config.server.id === selfId),
      fetchNodeStats(config.peer.id, config.peer.ip, config.peer.macmonPort, config.peer.id === selfId),
    ]);
    const ramOf = (n: typeof srv) => (n.snapshot ? n.snapshot.memory.ram_total / 1024 ** 3 : null);
    const intendedRam = usePeer ? ramOf(peer) : ramOf(srv);
    const otherRam = usePeer ? ramOf(srv) : ramOf(peer);
    if (intendedRam !== null && fitVerdict(sizeGB, intendedRam) === "exceeds") {
      const intended = usePeer ? config.peer : config.server;
      const other = usePeer ? config.server : config.peer;
      // Solo is a deliberate pin — warn, but never redirect behind the user's back.
      if (config.defaultMode === "solo") {
        console.log(
          dim(
            `${startupModel} (${sizeGB.toFixed(1)} GB) likely exceeds ${intended.id}'s wired-memory ` +
              `ceiling — serving here anyway (defaultMode: solo).`,
          ),
        );
      } else if (otherRam !== null && fitVerdict(sizeGB, otherRam) !== "exceeds") {
        console.log(
          dim(
            `${startupModel} (${sizeGB.toFixed(1)} GB) likely exceeds ${intended.id}'s wired-memory ` +
              `ceiling — serving from ${other.id} instead.`,
          ),
        );
        usePeer = !usePeer;
      } else {
        console.log(
          dim(
            `${startupModel} (${sizeGB.toFixed(1)} GB) likely exceeds the wired-memory ceiling of ` +
              `either Mac alone — consider /mode cluster once connected.`,
          ),
        );
      }
    }
  }
}

try {
  // An Ollama-served model must come back up under Ollama; --model overrides the remembered pair.
  session =
    prefs.backend === "ollama" && !model
      ? await startOllama(config, prefs.model ?? config.defaultModel, (line) => console.log(dim(line)))
      : usePeer
        ? await connectPreferPeer(config, model ?? prefs.model ?? undefined, (line) => console.log(dim(line)))
        : await connect(config, model ?? prefs.model ?? undefined, (line) => console.log(dim(line)));
} catch (err) {
  console.error(red(String(err instanceof Error ? err.message : err)));
  process.exit(1);
}

console.clear();
const ink = render(
  <App
    config={config}
    session={session}
    onQuit={shutdown}
    onActiveTime={(ms) => {
      sessionActiveMs += ms;
    }}
    // Keep every exit path pointed at the current session, not the startup one.
    onSessionChange={(s) => {
      session = s;
    }}
  />,
  // Disabled so App's useInput can route Ctrl+C through the graceful quit path.
  { exitOnCtrlC: false },
);

// Run before ink's own resize handler: wipe the screen so its repaint starts from a blank slate.
process.stdout.prependListener("resize", () => {
  ink.clear();
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
});
