import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface NodeConfig {
  id: string;
  ip: string;
  sshUser: string;
  macmonPort: number;
}

export interface ServerNodeConfig extends NodeConfig {
  apiPort: number;
  plistPath: string; // remote path, e.g. ~/Library/LaunchAgents/com.mlx-server.plist
  serviceLabel: string; // e.g. com.mlx-server
}

export interface ClusterConfig {
  // The Mac that runs mlx_lm.server as an always-on LaunchAgent (Pattern A).
  server: ServerNodeConfig;
  // The other Mac — used only for its stats (macmon), never SSH'd for control.
  peer: NodeConfig;
  defaultModel: string;
  localApiPort: number; // port used when this CLI spawns mlx_lm.server locally (fallback mode)
  venvPath: string; // e.g. ~/.venvs/mlx
}

const CONFIG_PATH = join(homedir(), ".mlx", "cluster-cli.json");

export const DEFAULT_CONFIG: ClusterConfig = {
  server: {
    id: "m1",
    ip: "10.0.0.1",
    sshUser: process.env.USER ?? "user",
    macmonPort: 9090,
    apiPort: 8080,
    plistPath: "~/Library/LaunchAgents/com.mlx-server.plist",
    serviceLabel: "com.mlx-server",
  },
  peer: {
    id: "m5",
    ip: "10.0.0.2",
    sshUser: process.env.USER ?? "user",
    macmonPort: 9090,
  },
  defaultModel: "mlx-community/Qwen3.6-35B-A3B-4bit-DWQ",
  localApiPort: 8080,
  venvPath: join(homedir(), ".venvs", "mlx"),
};

export class ConfigError extends Error {}

/**
 * Loads ~/.mlx/cluster-cli.json, falling back to DEFAULT_CONFIG for any
 * missing top-level keys. Throws ConfigError (not a crash) on malformed JSON
 * so the caller can show a clear message instead of an unreadable stack trace.
 */
export function loadConfig(): ClusterConfig {
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    throw new ConfigError(
      `${CONFIG_PATH} is not valid JSON (${(err as Error).message}) — fix it or delete it to use defaults`,
    );
  }
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError(`${CONFIG_PATH} must contain a JSON object`);
  }
  const r = raw as Partial<ClusterConfig>;
  return {
    server: { ...DEFAULT_CONFIG.server, ...r.server },
    peer: { ...DEFAULT_CONFIG.peer, ...r.peer },
    defaultModel: r.defaultModel ?? DEFAULT_CONFIG.defaultModel,
    localApiPort: r.localApiPort ?? DEFAULT_CONFIG.localApiPort,
    venvPath: r.venvPath ?? DEFAULT_CONFIG.venvPath,
  };
}

export { CONFIG_PATH };
