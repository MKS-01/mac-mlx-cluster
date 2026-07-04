import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { BLUE, DIM } from "../theme";

export function InputBar({
  disabled,
  busyText,
  onSubmit,
}: {
  disabled: boolean;
  busyText?: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");

  const submit = (v: string) => {
    setValue("");
    onSubmit(v);
  };

  return (
    // Round corners render as ╭╮ (how round they look is up to the terminal
    // font). Border tints blue while a reply is streaming so the box reads
    // as busy without extra text.
    <Box borderStyle="round" borderColor={disabled ? BLUE : DIM} paddingX={1}>
      <Text color={BLUE}>{"❯ "}</Text>
      {disabled ? (
        <Text color={DIM}>{busyText ?? "waiting for reply… (esc to cancel)"}</Text>
      ) : (
        <TextInput
          value={value}
          onChange={(v) => {
            // Ink batches an input chunk with no escape byte into a single
            // event (see ink/build/input-parser.js) — if Enter lands in the
            // same read() as other keystrokes (fast typing, or a literal
            // paste, which is common when dropping a prompt into a chat
            // CLI), key.return never fires and the \r/\n shows up here as a
            // literal character instead. Treat it as submit ourselves.
            if (/[\r\n]/.test(v)) submit(v.replace(/[\r\n]+/g, " ").trim());
            else setValue(v);
          }}
          onSubmit={submit}
          placeholder="message the model…  (/help for commands)"
        />
      )}
    </Box>
  );
}
