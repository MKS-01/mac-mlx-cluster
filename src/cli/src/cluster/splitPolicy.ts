// Wear-leveling policy: which Mac should host the model, given a target time-share (e.g.
// 60/40 server/peer) and the actual share so far. Metric is wall-clock active-session
// minutes per node — a proxy for GPU load, not true cycle wear.

export interface SplitTarget {
  server: number; // percent, server + peer === 100
  peer: number;
}

export interface SplitHistory {
  serverMinutes: number;
  peerMinutes: number;
}

export const DEFAULT_SPLIT: SplitTarget = { server: 50, peer: 50 };
export const EMPTY_HISTORY: SplitHistory = { serverMinutes: 0, peerMinutes: 0 };

// Host-load thresholds shared by every "is that Mac busy?" check (index.tsx, app.tsx), so
// they can't drift apart. Below IDLE_* a node is free; at/above BUSY_* something else is on it.
export const IDLE_CPU_PCT = 0.15;
export const IDLE_GPU_PCT = 0.1;
export const BUSY_CPU_PCT = 0.35;
export const BUSY_GPU_PCT = 0.25;

export const SPLIT_PRESETS: SplitTarget[] = [
  { server: 50, peer: 50 },
  { server: 55, peer: 45 },
  { server: 60, peer: 40 },
];

/** Accepts "60/40", "60:40", "60-40", or with spaces; rejects anything that doesn't sum to 100. */
export function parseSplit(arg: string): SplitTarget | null {
  const m = arg.trim().match(/^(\d{1,3})\s*[:/\-]\s*(\d{1,3})$/);
  if (!m) return null;
  const server = Number(m[1]);
  const peer = Number(m[2]);
  if (server <= 0 || peer <= 0 || server + peer !== 100) return null;
  return { server, peer };
}

export function formatSplit(t: SplitTarget): string {
  return `${t.server}/${t.peer}`;
}

/** Rounded actual percentages so far; {0, 0} before any session has completed. */
export function actualPct(history: SplitHistory): { server: number; peer: number } {
  const total = history.serverMinutes + history.peerMinutes;
  if (total <= 0) return { server: 0, peer: 0 };
  const server = Math.round((history.serverMinutes / total) * 100);
  return { server, peer: 100 - server };
}

/**
 * Which node should serve *this* session to nudge the actual ratio toward
 * target. Defaults to "server" with no history — preserves today's behavior
 * (attach/start the M1) for a fresh install or before any session completes.
 */
export function recommend(history: SplitHistory, target: SplitTarget): "server" | "peer" {
  const total = history.serverMinutes + history.peerMinutes;
  if (total <= 0) return "server";
  const actualServerPct = (history.serverMinutes / total) * 100;
  return actualServerPct < target.server ? "server" : "peer";
}
