import type { ChatMessage } from "./chat";

const GUTTER_WIDTH = 4; // ChatView's 2-col marker gutter + App's paddingX

/**
 * Whitespace cleanup applied to every rendered message (ChatView imports
 * this too, so line estimates below stay in sync with what's drawn):
 * models love trailing spaces and 3+ blank-line runs, which waste rows in a
 * height-budgeted transcript.
 */
export function cleanBody(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Rough wrapped-line count for a message body at a given terminal width. */
export function estimateLines(text: string, columns: number): number {
  const width = Math.max(10, columns - GUTTER_WIDTH);
  const body = cleanBody(text) || " ";
  return body.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil((line.length || 1) / width)), 0);
}

export interface Windowed {
  visible: ChatMessage[];
  hiddenCount: number;
}

/**
 * Picks the most recent messages that fit within `budget` terminal rows —
 * a tail/follow view, not manual scrollback. Ink has no real scroll region,
 * so keeping total rendered height within the terminal's rows is what keeps
 * the header/stats pinned in place instead of scrolling into history (see
 * ChatView.tsx). Always keeps at least the single most recent message, even
 * if it alone overflows the budget, so the view is never empty.
 */
export function windowMessages(history: ChatMessage[], columns: number, budget: number): Windowed {
  let remaining = Math.max(0, budget);
  const visible: ChatMessage[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const lines = estimateLines(history[i].content, columns) + 1; // +1 for the blank line between messages
    if (lines > remaining && visible.length > 0) break;
    visible.unshift(history[i]);
    remaining -= lines;
  }
  return { visible, hiddenCount: history.length - visible.length };
}
