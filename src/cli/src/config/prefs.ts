import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_SPLIT, EMPTY_HISTORY, type SplitHistory, type SplitTarget } from "../cluster/splitPolicy";

export interface Prefs {
  model: string | null;
  statsView: "combined" | "split" | null;
  splitTarget: SplitTarget;
  splitHistory: SplitHistory;
}

const PREFS_DIR = join(homedir(), ".mlx");
const PREFS_PATH = join(PREFS_DIR, "cluster-cli-prefs.json");

const DEFAULTS: Prefs = { model: null, statsView: null, splitTarget: DEFAULT_SPLIT, splitHistory: EMPTY_HISTORY };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function loadPrefs(): Prefs {
  try {
    if (existsSync(PREFS_PATH)) {
      const raw = JSON.parse(readFileSync(PREFS_PATH, "utf8"));
      const st = raw.splitTarget;
      const sh = raw.splitHistory;
      return {
        model: typeof raw.model === "string" ? raw.model : null,
        statsView: raw.statsView === "combined" || raw.statsView === "split" ? raw.statsView : null,
        splitTarget:
          st && isFiniteNumber(st.server) && isFiniteNumber(st.peer) && st.server + st.peer === 100
            ? { server: st.server, peer: st.peer }
            : DEFAULT_SPLIT,
        splitHistory:
          sh && isFiniteNumber(sh.serverMinutes) && isFiniteNumber(sh.peerMinutes)
            ? { serverMinutes: sh.serverMinutes, peerMinutes: sh.peerMinutes }
            : EMPTY_HISTORY,
      };
    }
  } catch {
    // corrupt prefs file — fall through to defaults, never crash on load
  }
  return { ...DEFAULTS };
}

export function savePrefs(prefs: Prefs): void {
  try {
    mkdirSync(PREFS_DIR, { recursive: true });
    writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2) + "\n");
  } catch {
    // prefs are a nicety; never crash on save
  }
}
