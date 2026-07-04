import React from "react";
import { Box, Text } from "ink";
import { BLUE, DIM, FG } from "../theme";

export function Header({ mode, model }: { mode: "cluster" | "local"; model: string }) {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={FG} bold>MLX</Text>
        <Text color={BLUE} bold> CLUSTER</Text>
      </Text>
      <Text color={DIM}>
        {mode === "cluster" ? "cluster mode" : "local mode (fallback)"} · {model}
      </Text>
    </Box>
  );
}
