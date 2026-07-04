import React from "react";
import { Box, Text } from "ink";
import { BLUE, DIM, FG } from "../theme";
import { version } from "../../../package.json";

// Half-block wordmark — plain Unicode block elements, renders in any mono
// font (same lettering style as readback-cli's Header). "MLX" in white,
// "CLUSTER" in the single static blue accent (never recolored by state).
const MARK: Array<[mlx: string, cluster: string]> = [
  ["█▀▄▀█ █   ▀▄▀  ", "█▀▀ █   █ █ █▀ ▀█▀ █▀▀ █▀█"],
  ["█ ▀ █ █▄▄ █ █  ", "█▄▄ █▄▄ █▄█ ▄█  █  ██▄ █▀▄"],
];

export function Header() {
  return (
    <Box flexDirection="column">
      {MARK.map(([mlx, cluster], i) => (
        <Box key={i}>
          <Text color={FG}>{mlx}</Text>
          <Text color={BLUE}>{cluster}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color={DIM}>two-Mac MLX inference cluster · </Text>
        <Text color={BLUE}>v{version}</Text>
      </Box>
      <Text color={DIM}>
        chat with the served model · <Text color={BLUE}>/model</Text> ·{" "}
        <Text color={BLUE}>/stats</Text> · <Text color={BLUE}>/clear</Text> ·{" "}
        <Text color={BLUE}>/help</Text>
      </Text>
    </Box>
  );
}
