import React from "react";
import { Box, Text } from "ink";
import { DIM, FG, GREEN, YELLOW, RED } from "../theme";
import type { NodeStats, CombinedStats } from "../macmon";

function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

function tempColor(c: number): string {
  if (c >= 90) return RED;
  if (c >= 75) return YELLOW;
  return GREEN;
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
  return (
    <Text>
      <Text color={FG}>{node.id}</Text>
      <Text color={DIM}> cpu </Text>
      <Text>{(s.cpu_usage_pct * 100).toFixed(0)}%</Text>
      <Text color={DIM}> gpu </Text>
      <Text>{(s.gpu_usage[1] * 100).toFixed(0)}%</Text>
      <Text color={DIM}> ram </Text>
      <Text>{gb(s.memory.ram_usage)}/{gb(s.memory.ram_total)}GB</Text>
      <Text color={DIM}> temp </Text>
      <Text color={tempColor(Math.max(cpuTemp, gpuTemp))}>
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
    return (
      <Text>
        <Text color={DIM}>cluster </Text>
        <Text>{combined.nodesUp}/{combined.nodesTotal} up</Text>
        <Text color={DIM}> · cpu </Text>
        <Text>{(combined.avgCpuPct * 100).toFixed(0)}%</Text>
        <Text color={DIM}> · ram </Text>
        <Text>{gb(combined.ramUsedBytes)}/{gb(combined.ramTotalBytes)}GB</Text>
        <Text color={DIM}> · temp </Text>
        <Text color={tempColor(Math.max(combined.maxCpuTempC, combined.maxGpuTempC))}>
          {combined.maxCpuTempC.toFixed(0)}°/{combined.maxGpuTempC.toFixed(0)}°
        </Text>
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
