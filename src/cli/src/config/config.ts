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

// "server": Pattern A, attach/bootstrap the server node, falling back to this Mac if unreachable.
// "solo": serve on this Mac from the start, skipping the server-node probe.
export type DefaultMode = "server" | "solo";

export interface ClusterConfig {
  server: ServerNodeConfig; // runs mlx_lm.server as an always-on LaunchAgent (Pattern A)
  peer: NodeConfig; // used only for stats, never SSH'd for control
  defaultMode: DefaultMode;
  defaultModel: string;
  // Model for /agent's coding loop, independent of the chat model; a MoE so tool rounds stay light.
  agentModel: string;
  localApiPort: number; // port for a locally spawned mlx_lm.server (fallback mode)
  venvPath: string; // e.g. ~/.venvs/mlx
  ollama: { host: string; port: number }; // /mode ollama, reuses Ollama's own model store
  distributed: {
    hostfile: string; // mlx.launch hostfile; rank 0's bind IP is read from it, not duplicated here
  };
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
  defaultMode: "server",
  defaultModel: "mlx-community/Qwen3.6-35B-A3B-4bit-DWQ",
  agentModel: "mlx-community/Qwen3.6-35B-A3B-4bit-DWQ",
  localApiPort: 8080,
  venvPath: join(homedir(), ".venvs", "mlx"),
  ollama: { host: "127.0.0.1", port: 11434 },
  distributed: {
    hostfile: join(homedir(), ".mlx", "tb-ring-hostfile.json"),
  },
};

export class ConfigError extends Error {}

// These fields end up in an SSH argv or remote shell command string, so validate here to block
// shell/SSH-option injection (e.g. sshUser starting with "-"). Deliberately permissive, not a full spec.
const USER_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
const HOST_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/; // IPv4, hostname, or bracketed-free IPv6
const LABEL_RE = /^[a-zA-Z0-9_.-]+$/; // launchd reverse-DNS-style service label
const PATH_RE = /^[~/][a-zA-Z0-9_./ -]*$/; // absolute or ~-relative unix path, no shell metacharacters
const REPO_RE = /^[\w.-]+\/[\w.-]+$/; // HF repo id "org/name" — reaches the request body + /model resolution

function assertMatches(value: string, re: RegExp, field: string): void {
  if (!re.test(value)) {
    throw new ConfigError(`${CONFIG_PATH}: "${field}" (${JSON.stringify(value)}) doesn't look like a valid ${field}`);
  }
}

function validateNode(n: NodeConfig, prefix: string): void {
  assertMatches(n.sshUser, USER_RE, `${prefix}.sshUser`);
  assertMatches(n.ip, HOST_RE, `${prefix}.ip`);
}

function validateConfig(c: ClusterConfig): ClusterConfig {
  validateNode(c.server, "server");
  validateNode(c.peer, "peer");
  assertMatches(c.server.plistPath, PATH_RE, "server.plistPath");
  assertMatches(c.server.serviceLabel, LABEL_RE, "server.serviceLabel");
  assertMatches(c.agentModel, REPO_RE, "agentModel");
  if (c.defaultMode !== "server" && c.defaultMode !== "solo") {
    throw new ConfigError(
      `${CONFIG_PATH}: "defaultMode" (${JSON.stringify(c.defaultMode)}) must be "server" or "solo"`,
    );
  }
  return c;
}

// Falls back to DEFAULT_CONFIG for missing keys; throws ConfigError on malformed JSON or an
// unsafe field shape, rather than a stack trace or silently running an attacker-controlled string.
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
  return validateConfig({
    server: { ...DEFAULT_CONFIG.server, ...r.server },
    peer: { ...DEFAULT_CONFIG.peer, ...r.peer },
    defaultMode: r.defaultMode ?? DEFAULT_CONFIG.defaultMode,
    defaultModel: r.defaultModel ?? DEFAULT_CONFIG.defaultModel,
    agentModel: r.agentModel ?? DEFAULT_CONFIG.agentModel,
    localApiPort: r.localApiPort ?? DEFAULT_CONFIG.localApiPort,
    venvPath: r.venvPath ?? DEFAULT_CONFIG.venvPath,
    ollama: { ...DEFAULT_CONFIG.ollama, ...r.ollama },
    distributed: { ...DEFAULT_CONFIG.distributed, ...r.distributed },
  });
}

export { CONFIG_PATH };
