import React from "react";
import { Box, Text } from "ink";
import { DIM, FG, BLUE, RED } from "../theme";
import type { ChatMessage } from "../../chat/chat";
import { cleanBody } from "../../chat/chatWindow";
import { ThinkingIndicator } from "./ThinkingIndicator";

// One transcript row: a fixed 2-col marker gutter + a flex content box, so
// wrapped lines get a hanging indent instead of crawling back under the
// marker (matters for long model replies).
function Row({
  marker,
  markerColor,
  children,
}: {
  marker: string;
  markerColor: string;
  children: React.ReactNode;
}) {
  return (
    <Box marginBottom={1}>
      <Box width={2} flexShrink={0}>
        <Text color={markerColor}>{marker}</Text>
      </Box>
      <Box flexGrow={1}>{children}</Box>
    </Box>
  );
}

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
      {visible.map((msg, i) =>
        msg.role === "user" ? (
          <Row key={i} marker="❯" markerColor={BLUE}>
            <Text color={DIM}>{cleanBody(msg.content)}</Text>
          </Row>
        ) : (
          <Row key={i} marker="●" markerColor={BLUE}>
            <Text color={FG}>{cleanBody(msg.content)}</Text>
          </Row>
        ),
      )}
      {streaming !== null &&
        (streaming === "" ? (
          <Box marginBottom={1}>
            <ThinkingIndicator />
          </Box>
        ) : (
          <Row marker="●" markerColor={BLUE}>
            <Text>
              <Text color={FG}>{cleanBody(streaming)}</Text>
              <Text color={DIM}>▌</Text>
            </Text>
          </Row>
        ))}
      {error && (
        <Box marginBottom={1}>
          <Text color={RED}>{error}</Text>
        </Box>
      )}
    </Box>
  );
}
