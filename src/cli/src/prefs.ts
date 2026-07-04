import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface Prefs {
  model: string | null;
  statsView: "combined" | "split" | null;
}

const PREFS_DIR = join(homedir(), ".mlx");
const PREFS_PATH = join(PREFS_DIR, "cluster-cli-prefs.json");

const DEFAULTS: Prefs = { model: null, statsView: null };

export function loadPrefs(): Prefs {
  try {
    if (existsSync(PREFS_PATH)) {
      const raw = JSON.parse(readFileSync(PREFS_PATH, "utf8"));
      return {
        model: typeof raw.model === "string" ? raw.model : null,
        statsView: raw.statsView === "combined" || raw.statsView === "split" ? raw.statsView : null,
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
