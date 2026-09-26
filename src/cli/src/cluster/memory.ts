// Single source of truth for "does this model fit" — mirrors mlxctl meminfo's verdict.
// The real gate is the wired-memory ceiling, not total RAM; we can't read the live sysctl on
// a remote node, so estimate it as a fraction of RAM (see ARCHITECTURE.md "Wired-memory limit").

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
