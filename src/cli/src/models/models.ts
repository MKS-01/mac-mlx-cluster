import type { ClusterConfig } from "../config/config";
import type { Session } from "../cluster/cluster";
import { runRemote } from "../net/ssh";

export interface CachedModel {
  repo: string; // org/name
  sizeGB: number;
}

export type ModelListResult = { ok: true; models: CachedModel[] } | { ok: false; message: string };

// One du per cached repo. `ls | xargs` instead of a bare glob because the
// remote login shell is zsh, where an unmatched glob is a hard error.
const LIST_CMD = "ls -d ~/.cache/huggingface/hub/models--* 2>/dev/null | xargs -I{} du -sk {}";

function parseDu(output: string): CachedModel[] {
  const models: CachedModel[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const base = m[2].split("/").pop() ?? "";
    if (!base.startsWith("models--")) continue;
    // HF cache dirs encode "org/name" as "models--org--name".
    const repo = base.slice("models--".length).replace("--", "/");
    models.push({ repo, sizeGB: Number(m[1]) / 1024 ** 2 });
  }
  return models.sort((a, b) => b.sizeGB - a.sizeGB);
}

/**
 * Lists the HF-cached models on whichever node actually serves — the remote
 * server node in cluster mode, this Mac in local mode. That cache is the
 * hard truth for /model: the server runs with HF_HUB_OFFLINE=1, so anything
 * not in it can't be switched to.
 */
export async function listServerModels(config: ClusterConfig, session: Session): Promise<ModelListResult> {
  if (session.mode === "local") {
    const proc = Bun.spawnSync(["sh", "-c", LIST_CMD]);
    if (proc.exitCode !== 0) {
      return { ok: false, message: `could not read the local HF cache: ${proc.stderr.toString().trim()}` };
    }
    return { ok: true, models: parseDu(proc.stdout.toString()) };
  }
  const r = await runRemote(config.server.sshUser, config.server.ip, LIST_CMD, 10_000);
  if (!r.ok) {
    return { ok: false, message: `could not read the model cache on ${config.server.id}: ${r.stderr || "ssh failed"}` };
  }
  return { ok: true, models: parseDu(r.stdout) };
}

/**
 * Verifies a repo is HF-cached on every node before a sharded (/mode
 * cluster) launch — this Mac's cache directly, the server node's over SSH.
 * Deliberately does NOT auto-copy: these are multi-GB transfers, so a
 * missing cache is reported (pointing at the rsync recipe) and left to the
 * user. An unreachable node counts as missing — the launch would fail there
 * anyway.
 */
/**
 * Size of one repo in this Mac's HF cache, or null if it isn't cached here.
 * Used by the startup memory-fit check — the local cache is a good proxy
 * for the size on either node, since snapshots are byte-identical copies.
 */
export function localModelSizeGB(repo: string): number | null {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const dir = `~/.cache/huggingface/hub/models--${repo.replace("/", "--")}`;
  const proc = Bun.spawnSync(["sh", "-c", `du -sk ${dir} 2>/dev/null`]);
  const m = proc.stdout.toString().match(/^(\d+)\s/);
  return m ? Number(m[1]) / 1024 ** 2 : null;
}

// HF repo ids are GitHub-style "org/name" — letters, digits, ., _, - only.
// Enforced before the id is interpolated into any shell/SSH command below,
// so an unresolved user-typed argument can never smuggle shell syntax.
const REPO_ID_RE = /^[\w.-]+\/[\w.-]+$/;

export async function checkCachedOnBothNodes(
  config: ClusterConfig,
  repo: string,
): Promise<{ ok: true } | { ok: false; missingOn: string[]; reason?: string }> {
  if (!REPO_ID_RE.test(repo)) {
    return {
      ok: false,
      missingOn: [],
      reason: `"${repo}" is not a valid model repo id — expected org/name, e.g. mlx-community/Qwen3.6-9B-4bit`,
    };
  }
  const dir = `~/.cache/huggingface/hub/models--${repo.replace("/", "--")}`;
  const cmd = `test -d ${dir}`;
  const missingOn: string[] = [];
  const local = Bun.spawnSync(["sh", "-c", cmd]);
  if (local.exitCode !== 0) missingOn.push("this Mac");
  const remote = await runRemote(config.server.sshUser, config.server.ip, cmd, 10_000);
  if (!remote.ok) missingOn.push(config.server.id);
  return missingOn.length === 0 ? { ok: true } : { ok: false, missingOn };
}

export type Resolved =
  | { kind: "match"; repo: string }
  | { kind: "ambiguous"; repos: string[] }
  | { kind: "none" };

/** mlxctl-style resolution: exact repo first, then unique case-insensitive substring. */
export function resolveModel(arg: string, models: CachedModel[]): Resolved {
  const exact = models.find((m) => m.repo === arg);
  if (exact) return { kind: "match", repo: exact.repo };
  const needle = arg.toLowerCase();
  const hits = models.filter((m) => m.repo.toLowerCase().includes(needle));
  if (hits.length === 1) return { kind: "match", repo: hits[0].repo };
  if (hits.length > 1) return { kind: "ambiguous", repos: hits.map((m) => m.repo) };
  return { kind: "none" };
}
