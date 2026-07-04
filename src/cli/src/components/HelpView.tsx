import React from "react";
import { Box, Text } from "ink";
import { DIM, FG } from "../theme";

const ROWS: [string, string][] = [
  ["/model", "list models cached on the serving node"],
  ["/model <name>", "switch model — substring ok, e.g. /model 27b"],
  ["/stats", "toggle combined ↔ per-node stats view"],
  ["/split", "show wear-leveling split target vs actual"],
  ["/split <ratio>", "set the target, e.g. /split 60/40 — next session onward"],
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
