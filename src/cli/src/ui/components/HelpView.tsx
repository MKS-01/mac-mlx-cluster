import React from "react";
import { Box, Text } from "ink";
import { DIM, FG } from "../theme";

const ROWS: [string, string][] = [
  ["/model", "list models cached on the serving node"],
  ["/model <name>", "switch model — substring ok, e.g. /model 27b"],
  ["/mode", "show how the model is served"],
  ["/mode solo", "serve on this Mac only (frees the server node)"],
  ["/mode cluster [<m>]", "shard across all nodes — for models too big for one"],
  ["/stats", "toggle combined ↔ per-node stats view"],
  ["/split", "show wear-leveling split target vs actual"],
  ["/split <ratio>", "set the target, e.g. /split 60/40 — next session onward"],
  ["/clear", "clear the chat transcript"],
  ["/help", "toggle this help"],
  ["/quit, /exit, q", "quit (tears down anything this session spawned)"],
];

export function HelpView() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {ROWS.map(([cmd, desc]) => (
        <Text key={cmd}>
          <Text color={FG}>{cmd.padEnd(21)}</Text>
          <Text color={DIM}>{desc}</Text>
        </Text>
      ))}
    </Box>
  );
}
