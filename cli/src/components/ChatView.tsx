import React from "react";
import { Box, Text } from "ink";
import { DIM, FG, BLUE, RED } from "../theme";
import type { ChatMessage } from "../chat";

// Deliberately NOT <Static> — Static permanently flushes to the real
// terminal scrollback, so the fixed header above it gets pushed up and out
// of view as the transcript grows (that's the whole "keeps scrolling down"
// bug). Instead the caller windows `visible` to whatever fits the terminal
// height (see chatWindow.ts) and this just re-renders that slice in place
// each frame, like the rest of the Ink tree.
export function ChatView({
  visible,
  hiddenCount,
  streaming,
  error,
}: {
  visible: ChatMessage[];
  hiddenCount: number;
  streaming: string | null;
  error: string | null;
}) {
  return (
    <Box flexDirection="column">
      {hiddenCount > 0 && (
        <Box marginBottom={1}>
          <Text color={DIM}>↑ {hiddenCount} earlier message{hiddenCount === 1 ? "" : "s"} (/clear to reset)</Text>
        </Box>
      )}
      {visible.map((msg, i) => (
        <Box key={i} marginBottom={1}>
          <Text>
            <Text color={msg.role === "user" ? BLUE : FG} bold>
              {msg.role === "user" ? "you" : "model"}
            </Text>
            <Text color={DIM}>{"  "}</Text>
            <Text>{msg.content}</Text>
          </Text>
        </Box>
      ))}
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
