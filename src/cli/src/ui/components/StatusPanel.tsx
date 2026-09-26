import React from "react";
import { Box, Text } from "ink";
import { DIM, FG } from "../theme";
import type { Session } from "../../cluster/cluster";
import type { NodeStats, CombinedStats } from "../../net/macmon";
import { StatsBar } from "./StatsBar";

// Left-hand label column width ("memory" is the longest label + 2 gap).
const LABEL_W = 8;

function Label({ text }: { text: string }) {
  return <Text color={DIM}>{text.padEnd(LABEL_W)}</Text>;
}

function serverLabel(session: Session): string {
  if (session.mode === "shard") return "sharded · all nodes (tensor parallel)";
  if (session.mode === "ollama") {
    return session.ollamaHandle?.proc ? "ollama · started by this session" : "ollama · attached";
  }
  if (session.mode === "local") {
    if (!session.localHandle) return "solo · your Mac (attached to running server)";
    return session.localOrigin === "takeover" ? "solo · your Mac" : "solo · your Mac (server unreachable)";
  }
  return session.clusterOrigin === "started" ? "server · started by this session" : "server · attached";
}

// Every value row truncates rather than wraps — app.tsx's line budget counts each as one row.
export function StatusPanel({
  session,
  view,
  nodes,
  combined,
  narrow = false,
  externalBusy = false,
}: {
  session: Session;
  view: "combined" | "split";
  nodes: NodeStats[];
  combined: CombinedStats;
  narrow?: boolean;
  // Rendered as a suffix, not a new row, so the panel's row count never changes.
  externalBusy?: boolean;
}) {
  return (
    <Box flexDirection="column">
      <Box>
        <Label text="memory" />
        <StatsBar view={view} nodes={nodes} combined={combined} narrow={narrow} />
      </Box>
      <Box>
        <Label text="model" />
        <Text color={FG} wrap="truncate-end">
          {session.model}
        </Text>
      </Box>
      <Box>
        <Label text="server" />
        <Text wrap="truncate-end">
          <Text color={FG}>{serverLabel(session)}</Text>
          {externalBusy && <Text color={DIM}> · busy (another client)</Text>}
        </Text>
      </Box>
    </Box>
  );
}
