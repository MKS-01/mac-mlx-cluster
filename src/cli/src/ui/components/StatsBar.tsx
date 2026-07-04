import React from "react";
import { Box, Text } from "ink";
import { DIM, FG, GREEN, YELLOW, RED } from "../theme";
import { pressureColor } from "../colorScale";
import type { NodeStats, CombinedStats } from "../../net/macmon";

function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

function tempColor(c: number): string {
  if (c >= 90) return RED;
  if (c >= 75) return YELLOW;
  return GREEN;
}

// Same idea as readback's ModelScreen fit-status coloring (green/yellow/red
// on the data value itself, e.g. "fits"/"tight"/"too big") — applied to the
// RAM figure here, not the wordmark/brand color, which stays static.
function ramColor(used: number, total: number): string {
  return total > 0 ? pressureColor(used / total) : DIM;
}

function NodeLine({ node }: { node: NodeStats }) {
  if (!node.snapshot) {
    return (
      <Text color={DIM}>
        {node.id}: unavailable {node.error ? `(${node.error})` : ""}
      </Text>
    );
  }
  const s = node.snapshot;
  const cpuTemp = s.temp.cpu_temp_avg;
  const gpuTemp = s.temp.gpu_temp_avg;
  // RAM leads — this line renders inside the StatusPanel "memory" row.
  return (
    <Text>
      <Text color={FG}>{node.id}</Text>
      <Text color={DIM}> ram </Text>
      <Text bold color={ramColor(s.memory.ram_usage, s.memory.ram_total)}>
        {gb(s.memory.ram_usage)}/{gb(s.memory.ram_total)}GB
      </Text>
      <Text color={DIM}> cpu </Text>
      <Text bold>{(s.cpu_usage_pct * 100).toFixed(0)}%</Text>
      <Text color={DIM}> gpu </Text>
      <Text bold>{(s.gpu_usage[1] * 100).toFixed(0)}%</Text>
      <Text color={DIM}> temp </Text>
      <Text bold color={tempColor(Math.max(cpuTemp, gpuTemp))}>
        {cpuTemp.toFixed(0)}°/{gpuTemp.toFixed(0)}°
      </Text>
    </Text>
  );
}

export function StatsBar({
  view,
  nodes,
  combined,
}: {
  view: "combined" | "split";
  nodes: NodeStats[];
  combined: CombinedStats;
}) {
  if (view === "combined") {
    if (combined.nodesUp === 0) {
      return <Text color={DIM}>stats unavailable — macmon unreachable on both nodes (/stats to retry)</Text>;
    }
    // The headline row of the StatusPanel — values bold so RAM/CPU pressure
    // reads at a glance (terminal cells can't grow, bold is the "big").
    return (
      <Text>
        <Text bold color={ramColor(combined.ramUsedBytes, combined.ramTotalBytes)}>
          {gb(combined.ramUsedBytes)}/{gb(combined.ramTotalBytes)}GB
        </Text>
        <Text color={DIM}> · cpu </Text>
        <Text bold>{(combined.avgCpuPct * 100).toFixed(0)}%</Text>
        <Text color={DIM}> · temp </Text>
        <Text bold color={tempColor(Math.max(combined.maxCpuTempC, combined.maxGpuTempC))}>
          {combined.maxCpuTempC.toFixed(0)}°/{combined.maxGpuTempC.toFixed(0)}°
        </Text>
        <Text color={DIM}> · </Text>
        <Text bold>{combined.nodesUp}/{combined.nodesTotal} up</Text>
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      {nodes.map((n) => (
        <NodeLine key={n.id} node={n} />
      ))}
    </Box>
  );
}
