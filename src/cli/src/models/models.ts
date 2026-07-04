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
