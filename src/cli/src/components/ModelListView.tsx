import React from "react";
import { Box, Text } from "ink";
import { BLUE, DIM, FG, GREEN, RED, YELLOW } from "../theme";
import type { CachedModel } from "../models";

// Fit verdict for a quantized model's weights against the serving node's
// RAM. Weights alone aren't the whole story (KV cache, OS headroom), hence
// the conservative thresholds — same idea as readback's ModelList.
function fit(sizeGB: number, ramGB: number | null): { text: string; color: string } | null {
  if (ramGB === null) return null;
  if (sizeGB < ramGB * 0.65) return { text: "fits", color: GREEN };
  if (sizeGB < ramGB * 0.8) return { text: "tight", color: YELLOW };
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
  const namePad = Math.max(...models.map((m) => m.repo.length));
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
            <Text color={isActive ? FG : DIM}>{m.repo.padEnd(namePad)}</Text>
            <Text color={DIM}>{"  "}{m.sizeGB.toFixed(1).padStart(5)} GB{"  "}</Text>
            {verdict && <Text color={verdict.color}>{verdict.text}</Text>}
          </Box>
        );
      })}
      <Text color={DIM}>
        <Text color={BLUE}>/model {"<name or substring>"}</Text> to switch (a few seconds of downtime)
      </Text>
    </Box>
  );
}
