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
  if (session.mode === "local") {
    // Attached (localHandle null): serving through a local server someone
    // else started (another client, a previous session) — not ours to stop.
    if (!session.localHandle) return "solo · this Mac (attached to running server)";
    // A deliberate takeover (wear-leveling turn, /mode solo) reads
    // differently than an emergency fallback with the server unreachable.
    return session.localOrigin === "takeover" ? "solo · this Mac" : "solo · this Mac (server unreachable)";
  }
  return session.clusterOrigin === "started" ? "server · started by this session" : "server · attached";
}

/**
 * The dedicated model/memory section under the wordmark — same idea as
 * readback's StatusLine (dim label, FG value), but as a labeled block since
 * the cluster has more live state than readback's one-liner.
 *
 * Every value row truncates rather than wraps: app.tsx's line budget counts
 * each of these as exactly one row, so a wrapped long model name would
 * silently push the transcript off-screen.
 */
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
  // Another client is generating on the serving node while this CLI sits
  // idle — derived in app.tsx's stats poll, rendered as a suffix so the
  // panel's row count never changes.
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
