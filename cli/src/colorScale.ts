import { GREEN, YELLOW, RED } from "./theme";

/** Green/yellow/red status tints from readback's Ghost palette, by pressure fraction (0-1). */
export function pressureColor(pct: number): string {
  if (pct >= 0.85) return RED;
  if (pct >= 0.6) return YELLOW;
  return GREEN;
}
