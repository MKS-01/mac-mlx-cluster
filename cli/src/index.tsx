import React from "react";
import { render } from "ink";
import { App } from "./app";
import { connect, disconnect, disconnectSync, type Session } from "./cluster";
import { loadConfig, ConfigError, type ClusterConfig } from "./config";
import { loadPrefs } from "./prefs";

function parseArgs() {
  const args = process.argv.slice(2);
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) model = args[++i];
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log("mlx-cluster-cli [--model <repo>]");
      process.exit(0);
    }
  }
  return { model };
}

const dim = (s: string) => `\x1b[38;2;128;128;128m${s}\x1b[0m`;
const red = (s: string) => `\x1b[38;2;255;93;93m${s}\x1b[0m`;

let session: Session | null = null;
let shutdownDone = false;

let config: ClusterConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error(red(err instanceof ConfigError ? err.message : String(err)));
  process.exit(1);
}

// Normal quit path (Ctrl+C, /quit, SIGTERM) — can await the SSH round trip
// needed to bootout a server this session started (see cluster.ts).
async function shutdown(): Promise<void> {
  if (shutdownDone) return;
  shutdownDone = true;
  await disconnect(config, session);
}

// Safety net for paths where Node won't run async work (the 'exit' event,
// or right after an uncaught exception) — best-effort synchronous cleanup
// so an abnormal exit doesn't orphan a model loaded on the M1's RAM.
function shutdownSyncFallback(): void {
  if (shutdownDone) return;
  shutdownDone = true;
  disconnectSync(config, session);
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
process.on("exit", shutdownSyncFallback);
process.on("uncaughtException", (err) => {
  console.error(red(String(err instanceof Error ? err.stack ?? err.message : err)));
  shutdownSyncFallback();
  process.exit(1);
});

const { model } = parseArgs();
const prefs = loadPrefs();

try {
  session = await connect(config, model ?? prefs.model ?? undefined, (line) => console.log(dim(line)));
} catch (err) {
  console.error(red(String(err instanceof Error ? err.message : err)));
  process.exit(1);
}

console.clear();
const ink = render(<App config={config} session={session} onQuit={shutdown} />);

// On resize the previous frame re-wraps, so ink erases the wrong number of
// lines and stale copies pile up. Run BEFORE ink's own resize handler
// (prependListener): drop ink's frame tracking and wipe the screen, so the
// repaint ink is about to do always starts from a blank slate at the top.
process.stdout.prependListener("resize", () => {
  ink.clear();
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
});
