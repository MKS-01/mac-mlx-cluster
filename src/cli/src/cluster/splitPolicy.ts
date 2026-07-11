// Wear-leveling policy: which Mac should host the model this session, given
// a target time-share (e.g. 60/40 server/peer) and how the actual share has
// looked so far. "server" = config.server (the M1, normally always-on via
// LaunchAgent); "peer" = config.peer (the M5, normally the dev machine that
// runs this CLI) serving via local-fallback instead.
//
// The metric is wall-clock minutes each node was the CLI's active session
// target — not true GPU-cycle wear, but a reasonable proxy: the model only
// draws real inference load while something is actually talking to it.

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

// Host-load thresholds (fractions, matching macmon's cpu_usage_pct /
// gpu_usage[1]), shared by every consumer that asks "is that Mac busy with
// something else?": the startup wear-leveling check (index.tsx) and the
// external-activity indicator in the status panel (app.tsx). One definition
// so the two checks can never drift apart. Below IDLE_* a node is clearly
// free; at/above BUSY_* something else is working it.
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
