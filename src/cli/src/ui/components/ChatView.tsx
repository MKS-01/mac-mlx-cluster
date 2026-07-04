import React from "react";
import { Box, Text } from "ink";
import { DIM, BLUE, RED } from "../theme";
import type { ChatMessage } from "../../chat/chat";
import { cleanBody } from "../../chat/chatWindow";
import { Markdown } from "../markdown";
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
  pinnedQuestion,
}: {
  visible: ChatMessage[];
  hiddenCount: number;
  streaming: string | null;
  error: string | null;
  // The question being answered, when it has scrolled out of the window —
  // pinned as a single truncated line so long replies never orphan their
  // prompt (cleared with the transcript, like everything else).
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
