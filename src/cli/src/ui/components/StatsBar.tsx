import React from "react";
import { Box, Text } from "ink";
import { DIM, FG, GREEN, YELLOW, RED, TRACK } from "../theme";
import { pressureColor } from "../colorScale";
import type { NodeStats, CombinedStats } from "../../net/macmon";

// Gauge width in cells. Wide enough to read pressure at a glance, narrow
// enough that a split-view line (id + bar + figures + suffix) fits 80 cols.
const BAR_WIDTH = 16;
// Lower-3/4 block for BOTH fill and track: same glyph = same height (no
// stepped seam between fill and track), and the empty top quarter keeps
// adjacent rows' bars from fusing into one blob — full-height █ touches the
// row above/below.
const BAR_CH = "▆";

function tempColor(c: number): string {
  if (c >= 90) return RED;
  if (c >= 75) return YELLOW;
  return GREEN;
}

// "14.2" for used (one decimal), "32" for whole-number totals — matches the
// README's mock ("14.2 / 32 GB") and keeps the line from reading as noise.
function gbUsed(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}
function gbTotal(bytes: number): string {
  const g = bytes / 1024 ** 3;
  return Number.isInteger(g) ? String(g) : g.toFixed(1);
}

/**
 * Horizontal RAM gauge: filled cells take the green/yellow/red pressure
 * color (the bar itself is the at-a-glance signal), track stays dark.
 */
function Bar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(1, pct));
  const filled = Math.round(clamped * BAR_WIDTH);
  return (
    <Text>
      <Text color={pressureColor(clamped)}>{BAR_CH.repeat(filled)}</Text>
      <Text color={TRACK}>{BAR_CH.repeat(BAR_WIDTH - filled)}</Text>
    </Text>
  );
}

function NodeLine({ node, idPad, narrow }: { node: NodeStats; idPad: number; narrow: boolean }) {
  if (!node.snapshot) {
    return (
      <Text>
        <Text color={DIM}>{node.id.padEnd(idPad)} </Text>
        <Text color={TRACK}>{BAR_CH.repeat(BAR_WIDTH)}</Text>
        <Text color={DIM}> unavailable{node.error ? ` (${node.error})` : ""}</Text>
      </Text>
    );
  }
  const s = node.snapshot;
  const cpuTemp = s.temp.cpu_temp_avg;
  const gpuTemp = s.temp.gpu_temp_avg;
  return (
    <Text>
      <Text color={FG}>{node.id.padEnd(idPad)} </Text>
      <Bar pct={s.memory.ram_total > 0 ? s.memory.ram_usage / s.memory.ram_total : 0} />
      <Text color={DIM}>
        {" "}
        {gbUsed(s.memory.ram_usage).padStart(4)} / {gbTotal(s.memory.ram_total)} GB
      </Text>
      <Text color={DIM}>
        {"  · cpu "}
        {(s.cpu_usage_pct * 100).toFixed(0)}% gpu {(s.gpu_usage[1] * 100).toFixed(0)}%
      </Text>
      {!narrow && (
        <Text>
          <Text color={DIM}>{" · "}</Text>
          <Text color={tempColor(Math.max(cpuTemp, gpuTemp))}>
            {cpuTemp.toFixed(0)}°/{gpuTemp.toFixed(0)}°
          </Text>
        </Text>
      )}
    </Text>
  );
}

export function StatsBar({
  view,
  nodes,
  combined,
  narrow = false,
}: {
  view: "combined" | "split";
  nodes: NodeStats[];
  combined: CombinedStats;
  // Below ~80 columns a full stats line wraps and silently eats the line
  // budget (app.tsx sizes the transcript assuming each panel row is one
  // row) — degrade by dropping temps first; the bar + GB is the core signal.
  narrow?: boolean;
}) {
  if (view === "combined") {
    if (combined.nodesUp === 0) {
      return <Text color={DIM}>stats unavailable — macmon unreachable on both nodes (/stats to retry)</Text>;
    }
    const pct = combined.ramTotalBytes > 0 ? combined.ramUsedBytes / combined.ramTotalBytes : 0;
    return (
      <Text>
        <Bar pct={pct} />
        <Text color={DIM}>
          {" "}
          {gbUsed(combined.ramUsedBytes)} / {gbTotal(combined.ramTotalBytes)} GB{"  · cpu "}
          {(combined.avgCpuPct * 100).toFixed(0)}% gpu {(combined.avgGpuPct * 100).toFixed(0)}%
        </Text>
        {!narrow && (
          <Text>
            <Text color={DIM}>{" · "}</Text>
            <Text color={tempColor(Math.max(combined.maxCpuTempC, combined.maxGpuTempC))}>
              {combined.maxCpuTempC.toFixed(0)}°/{combined.maxGpuTempC.toFixed(0)}°
            </Text>
          </Text>
        )}
        <Text color={DIM}>
          {" · "}
          {combined.nodesUp}/{combined.nodesTotal} up
        </Text>
      </Text>
    );
  }
  const idPad = Math.max(...nodes.map((n) => n.id.length), 2);
  return (
    <Box flexDirection="column">
      {nodes.map((n) => (
        <NodeLine key={n.id} node={n} idPad={idPad} narrow={narrow} />
      ))}
    </Box>
  );
}
