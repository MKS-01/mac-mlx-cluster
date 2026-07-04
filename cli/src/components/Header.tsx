import React from "react";
import { Box, Text } from "ink";
import { BLUE, DIM, FG } from "../theme";

// Letter-spaced wordmark — a simple, safe stand-in for readback's block-art
// mark (hand-drawn Unicode block letters are easy to mangle across fonts).
// Two-tone: MLX in white, CLUSTER in blue.
export function Header({ mode, model }: { mode: "cluster" | "local"; model: string }) {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={FG} bold>M L X</Text>
        <Text color={BLUE} bold>  C L U S T E R</Text>
      </Text>
      <Text color={DIM}>two-Mac MLX inference cluster</Text>
      <Text color={DIM}>
        {mode === "cluster" ? "cluster mode" : "local mode (fallback)"} · {model}
      </Text>
    </Box>
  );
}
