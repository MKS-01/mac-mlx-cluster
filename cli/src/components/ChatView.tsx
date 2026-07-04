import React from "react";
import { Box, Text, Static } from "ink";
import { DIM, FG, BLUE, RED } from "../theme";
import type { ChatMessage } from "../chat";

// Only completed messages go through <Static> (Ink never re-renders these —
// required for a scrolling transcript that doesn't repaint on every token).
// The in-flight assistant reply renders separately below, live.
export function ChatView({
  history,
  streaming,
  error,
}: {
  history: ChatMessage[];
  streaming: string | null;
  error: string | null;
}) {
  return (
    <Box flexDirection="column">
      <Static items={history}>
        {(msg, i) => (
          <Box key={i} marginBottom={1}>
            <Text>
              <Text color={msg.role === "user" ? BLUE : FG} bold>
                {msg.role === "user" ? "you" : "model"}
              </Text>
              <Text color={DIM}>{"  "}</Text>
              <Text>{msg.content}</Text>
            </Text>
          </Box>
        )}
      </Static>
      {streaming !== null && (
        <Box marginBottom={1}>
          <Text>
            <Text color={FG} bold>model</Text>
            <Text color={DIM}>  </Text>
            <Text>{streaming}</Text>
            <Text color={DIM}>▌</Text>
          </Text>
        </Box>
      )}
      {error && (
        <Box marginBottom={1}>
          <Text color={RED}>{error}</Text>
        </Box>
      )}
    </Box>
  );
}
