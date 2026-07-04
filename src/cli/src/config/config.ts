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
  // Pattern B (/mode cluster) — tensor-parallel sharding across both Macs.
  distributed: {
    // mlx.launch hostfile; rank 0's bind IP is read from this file at launch
    // time (first entry = rank 0) rather than duplicated here.
    hostfile: string;
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
  defaultModel: "mlx-community/Qwen3.6-35B-A3B-4bit-DWQ",
  localApiPort: 8080,
  venvPath: join(homedir(), ".venvs", "mlx"),
  distributed: {
    hostfile: join(homedir(), ".mlx", "tb-ring-hostfile.json"),
  },
};

export class ConfigError extends Error {}

// Every one of these fields ends up inside an SSH argv or a remote shell
// command string (ssh.ts, distributed.ts) — validated once here so a typo'd
// or hostile config.json can't smuggle a shell/SSH-option injection (e.g. a
// sshUser starting with "-" being parsed as an ssh flag) instead of just
// failing to connect. Shapes are deliberately permissive (real usernames,
// IPs/hostnames, launchd labels, and unix paths all fit), not a full spec.
const USER_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
const HOST_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/; // IPv4, hostname, or bracketed-free IPv6
const LABEL_RE = /^[a-zA-Z0-9_.-]+$/; // launchd reverse-DNS-style service label
const PATH_RE = /^[~/][a-zA-Z0-9_./ -]*$/; // absolute or ~-relative unix path, no shell metacharacters

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
  return c;
}

/**
 * Loads ~/.mlx/cluster-cli.json, falling back to DEFAULT_CONFIG for any
 * missing top-level keys. Throws ConfigError (not a crash) on malformed JSON
 * or a field shape that can't be safely used in an SSH/shell command, so the
 * caller can show a clear message instead of an unreadable stack trace (or
 * worse, silently running an attacker-controlled string).
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
  return validateConfig({
    server: { ...DEFAULT_CONFIG.server, ...r.server },
    peer: { ...DEFAULT_CONFIG.peer, ...r.peer },
    defaultModel: r.defaultModel ?? DEFAULT_CONFIG.defaultModel,
    localApiPort: r.localApiPort ?? DEFAULT_CONFIG.localApiPort,
    venvPath: r.venvPath ?? DEFAULT_CONFIG.venvPath,
    distributed: { ...DEFAULT_CONFIG.distributed, ...r.distributed },
  });
}

export { CONFIG_PATH };
