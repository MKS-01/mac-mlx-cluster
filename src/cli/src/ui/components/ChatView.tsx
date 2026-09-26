import React from "react";
import { Box, Text } from "ink";
import { DIM, BLUE, RED } from "../theme";
import type { ChatMessage } from "../../chat/chat";
import { cleanBody } from "../../chat/chatWindow";
import { Markdown } from "../markdown";
import { ThinkingIndicator } from "./ThinkingIndicator";

// Fixed 2-col marker gutter + flex content, so wrapped lines get a hanging indent.
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

// Deliberately NOT <Static> — that flushes to real scrollback and pushes the fixed header
// out of view. The caller windows `visible` to the terminal height instead (chatWindow.ts).
export function ChatView({
  visible,
  hiddenCount,
  streaming,
  error,
  pinnedQuestion,
}: {
  visible: ChatMessage[];
  hiddenCount: number;
  streaming: string | null;
  error: string | null;
  // Question being answered, pinned as one line when it scrolls out of the window.
  pinnedQuestion?: string | null;
}) {
  return (
    <Box flexDirection="column">
      {pinnedQuestion && (
        <Box marginBottom={1}>
          <Box width={2} flexShrink={0}>
            <Text color={BLUE}>❯</Text>
          </Box>
          <Box flexGrow={1}>
            <Text color={DIM} wrap="truncate-end">
              {pinnedQuestion.replace(/\s+/g, " ").trim()}
            </Text>
          </Box>
        </Box>
      )}
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
        ) : msg.role === "action" ? (
          // Agent tool activity: tight, no marker, reads as a compact log.
          <Box key={i}>
            <Box width={2} flexShrink={0} />
            <Box flexGrow={1}>
              <Text color={DIM} wrap="truncate-end">
                {msg.content}
              </Text>
            </Box>
          </Box>
        ) : (
          <Row key={i} marker="●" markerColor={BLUE}>
            <Markdown text={cleanBody(msg.content)} />
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
              <Markdown text={cleanBody(streaming)} />
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
