// Single source of truth for "does this model fit that Mac's unified
// memory" — the CLI-side mirror of mlxctl meminfo's verdict. Used by the
// /model list's fit column, the /model switch pre-flight, and the startup
// serve-node override, so all three agree.
//
// The real gate isn't total RAM but the wired-memory ceiling
// (iogpu.wired_limit_mb / max_recommended_working_set_size — see
// ARCHITECTURE.md "Wired-memory limit"). We can't read the live sysctl on a
// remote node from here, so estimate the ceiling as a fraction of RAM
// (macOS defaults land around 70-75%) and warn at the same 90%-of-ceiling
// threshold mlx-lm and mlxctl use.

const ESTIMATED_CEILING_FRACTION = 0.72;
const WIRED_WARN_FRACTION = 0.9; // keep in sync with mlxctl's WIRED_WARN_FRACTION

export type FitVerdict = "fits" | "tight" | "exceeds";

export function fitVerdict(modelSizeGB: number, ramGB: number): FitVerdict {
  const ceilingGB = ramGB * ESTIMATED_CEILING_FRACTION;
  if (modelSizeGB < ceilingGB * WIRED_WARN_FRACTION) return "fits";
  if (modelSizeGB < ceilingGB) return "tight";
  return "exceeds";
}

/** The estimated wired ceiling itself, for messages ("~23 GB of 32 GB"). */
export function estimatedCeilingGB(ramGB: number): number {
  return ramGB * ESTIMATED_CEILING_FRACTION;
}
