import type { ChatMessage } from "./chat";

const LABEL_WIDTH = 7; // "you  " / "model  " prefix, roughly

/** Rough wrapped-line count for a message body at a given terminal width. */
export function estimateLines(text: string, columns: number): number {
  const width = Math.max(10, columns - LABEL_WIDTH);
  const body = text.length > 0 ? text : " ";
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
