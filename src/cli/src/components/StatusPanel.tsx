import React from "react";
import { Box, Text } from "ink";
import { DIM, FG } from "../theme";
import type { Session } from "../cluster";
import type { NodeStats, CombinedStats } from "../macmon";
import { StatsBar } from "./StatsBar";

// Left-hand label column width ("memory" is the longest label + 2 gap).
const LABEL_W = 8;

function Label({ text }: { text: string }) {
  return <Text color={DIM}>{text.padEnd(LABEL_W)}</Text>;
}

function serverLabel(session: Session): string {
  if (session.mode === "local") return "local fallback · spawned";
  return session.clusterOrigin === "started" ? "cluster · started by this session" : "cluster · attached";
}

/**
 * The dedicated model/memory section under the wordmark — same idea as
 * readback's StatusLine (dim label, FG value), but as a labeled block since
 * the cluster has more live state than readback's one-liner.
 */
export function StatusPanel({
  session,
  view,
  nodes,
  combined,
}: {
  session: Session;
  view: "combined" | "split";
  nodes: NodeStats[];
  combined: CombinedStats;
}) {
  return (
    <Box flexDirection="column">
      <Box>
        <Label text="memory" />
        <StatsBar view={view} nodes={nodes} combined={combined} />
      </Box>
      <Box>
        <Label text="model" />
        <Text color={FG}>{session.model}</Text>
      </Box>
      <Box>
        <Label text="server" />
        <Text color={FG}>{serverLabel(session)}</Text>
      </Box>
    </Box>
  );
}
