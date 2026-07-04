// Polls `macmon serve` (http://<host>:<port>/json) on one or more Macs and
// aggregates into combined + per-node figures for the stats bar.
// Confirmed field shape locally (macmon 1.x):
// { cpu_usage_pct, gpu_usage: [count, pct], memory: { ram_total, ram_usage },
//   temp: { cpu_temp_avg, gpu_temp_avg }, ... }

export interface MacmonSnapshot {
  cpu_usage_pct: number;
  gpu_usage: [number, number];
  memory: { ram_total: number; ram_usage: number };
  temp: { cpu_temp_avg: number; gpu_temp_avg: number };
}

export interface NodeStats {
  id: string;
  reachable: boolean;
  snapshot: MacmonSnapshot | null;
  error: string | null;
}

/** Fetches one snapshot, never throws — unreachable nodes just report `reachable: false`. */
export async function fetchMacmon(base: string, timeoutMs = 1500): Promise<MacmonSnapshot | null> {
  try {
    const res = await fetch(`${base}/json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<MacmonSnapshot>;
    if (!data.memory || !data.temp) return null; // malformed payload — treat as unreachable
    return data as MacmonSnapshot;
  } catch {
    return null;
  }
}

export async function fetchNodeStats(id: string, host: string, port: number): Promise<NodeStats> {
  const base = `http://${host}:${port}`;
  const snapshot = await fetchMacmon(base);
  return snapshot
    ? { id, reachable: true, snapshot, error: null }
    : { id, reachable: false, snapshot: null, error: `macmon unreachable at ${base}` };
}

export interface CombinedStats {
  ramUsedBytes: number;
  ramTotalBytes: number;
  avgCpuPct: number; // average across reachable nodes
  maxCpuTempC: number;
  maxGpuTempC: number;
  nodesUp: number;
  nodesTotal: number;
}

export function combineStats(nodes: NodeStats[]): CombinedStats {
  const up = nodes.filter((n) => n.snapshot);
  const ramUsedBytes = up.reduce((s, n) => s + n.snapshot!.memory.ram_usage, 0);
  const ramTotalBytes = up.reduce((s, n) => s + n.snapshot!.memory.ram_total, 0);
  const avgCpuPct = up.length
    ? up.reduce((s, n) => s + n.snapshot!.cpu_usage_pct, 0) / up.length
    : 0;
  const maxCpuTempC = up.length ? Math.max(...up.map((n) => n.snapshot!.temp.cpu_temp_avg)) : 0;
  const maxGpuTempC = up.length ? Math.max(...up.map((n) => n.snapshot!.temp.gpu_temp_avg)) : 0;
  return { ramUsedBytes, ramTotalBytes, avgCpuPct, maxCpuTempC, maxGpuTempC, nodesUp: up.length, nodesTotal: nodes.length };
}
