import React from "react";
import { Box, Text } from "ink";
import { BLUE, DIM, FG, GREEN, RED, YELLOW } from "../theme";
import type { CachedModel } from "../../models/models";
import { fitVerdict } from "../../cluster/memory";

// Rendering of the shared wired-ceiling fit verdict (cluster/memory.ts) —
// weights alone aren't the whole story (KV cache, OS headroom), which the
// estimated-ceiling thresholds there account for.
function fit(sizeGB: number, ramGB: number | null): { text: string; color: string } | null {
  if (ramGB === null) return null;
  const v = fitVerdict(sizeGB, ramGB);
  if (v === "fits") return { text: "fits", color: GREEN };
  if (v === "tight") return { text: "tight", color: YELLOW };
  return { text: "too big", color: RED };
}

export function ModelListView({
  models,
  current,
  nodeId,
  ramGB,
}: {
  models: CachedModel[];
  current: string;
  nodeId: string;
  ramGB: number | null;
}) {
  if (models.length === 0) {
    return (
      <Box marginBottom={1}>
        <Text color={DIM}>
          no models cached on {nodeId} — download one there first (mlxctl download {"<repo>"})
        </Text>
      </Box>
    );
  }
  // Cap the name column so one unusually long repo id can't widen every row
  // past the terminal and wrap (each wrapped row breaks app.tsx's line
  // budget). 48 chars fits the usual mlx-community/… ids untruncated.
  const NAME_MAX = 48;
  const namePad = Math.min(Math.max(...models.map((m) => m.repo.length)), NAME_MAX);
  const repoLabel = (repo: string) =>
    repo.length > NAME_MAX ? `${repo.slice(0, NAME_MAX - 1)}…` : repo.padEnd(namePad);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={DIM}>
        models cached on {nodeId}
        {ramGB !== null ? ` (${ramGB.toFixed(0)} GB)` : ""}:
      </Text>
      {models.map((m) => {
        const isActive = m.repo === current;
        const verdict = fit(m.sizeGB, ramGB);
        return (
          <Box key={m.repo}>
            <Text color={BLUE}>{isActive ? "★ " : "  "}</Text>
            <Text color={isActive ? FG : DIM}>{repoLabel(m.repo)}</Text>
            <Text color={DIM}>{"  "}{m.sizeGB.toFixed(1).padStart(5)} GB</Text>
            {verdict && (
              <Text>
                <Text color={DIM}>{"  · "}</Text>
                <Text color={verdict.color}>{verdict.text}</Text>
              </Text>
            )}
          </Box>
        );
      })}
      <Text color={DIM}>
        <Text color={BLUE}>/model {"<name or substring>"}</Text> to switch (a few seconds of downtime)
      </Text>
    </Box>
  );
}
