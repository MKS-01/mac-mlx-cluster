import React from "react";
import { Box, Text } from "ink";
import { BLUE, DIM, FG } from "../theme";
import { version } from "../../../package.json";

// Replica of the README hero. Deliberately no big-glyph banner — block lettering reads as
// noise at large terminal font sizes.
export function Header() {
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color={FG}>
          MLX{" "}
        </Text>
        <Text bold color={BLUE}>
          CLUSTER
        </Text>
      </Text>
      <Box marginTop={1}>
        <Text color={DIM}>MLX inference — solo, server, or sharded across Macs · </Text>
        <Text color={BLUE}>v{version}</Text>
      </Box>
    </Box>
  );
}
