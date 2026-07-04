import React from "react";
import { Box, Text } from "ink";
import { DIM, FG } from "../theme";

const ROWS: [string, string][] = [
  ["/model", "show current model"],
  ["/model <repo>", "switch the served model (a few seconds of downtime)"],
  ["/stats", "toggle combined ↔ per-node stats view"],
  ["/clear", "clear the chat transcript"],
  ["/help", "toggle this help"],
  ["/quit, /exit, q", "quit (tears down a locally-spawned server, if any)"],
];

export function HelpView() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {ROWS.map(([cmd, desc]) => (
        <Text key={cmd}>
          <Text color={FG}>{cmd.padEnd(16)}</Text>
          <Text color={DIM}>{desc}</Text>
        </Text>
      ))}
    </Box>
  );
}
