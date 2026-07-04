import React from "react";
import { Text } from "ink";
import { BLUE } from "./theme";

// Lightweight markdown for model replies: headings, **bold**, `code`, and
// list bullets — the constructs local models actually emit. Anything else
// passes through as plain text; unterminated markers (mid-stream) fall
// through literally, so streaming never renders half-parsed garbage.
//
// Rendering only ever REMOVES marker characters (###, **, backticks), so
// chatWindow.ts's raw-text line estimates stay >= the drawn height — the
// safe direction for the transcript's height budget.

function renderInline(line: string, keyBase: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      parts.push(
        <Text key={`${keyBase}b${i++}`} bold>
          {tok.slice(2, -2)}
        </Text>,
      );
    } else {
      parts.push(
        <Text key={`${keyBase}c${i++}`} color={BLUE}>
          {tok.slice(1, -1)}
        </Text>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <Text>
      {lines.map((line, idx) => {
        const nl = idx < lines.length - 1 ? "\n" : "";
        const heading = line.match(/^#{1,6}\s+(.*)$/);
        if (heading) {
          return (
            <Text key={idx} bold>
              {renderInline(heading[1], String(idx))}
              {nl}
            </Text>
          );
        }
        const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
        if (bullet) {
          return (
            <Text key={idx}>
              {bullet[1]}
              <Text color={BLUE}>{"• "}</Text>
              {renderInline(bullet[2], String(idx))}
              {nl}
            </Text>
          );
        }
        return (
          <Text key={idx}>
            {renderInline(line, String(idx))}
            {nl}
          </Text>
        );
      })}
    </Text>
  );
}
