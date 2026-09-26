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
    // Border tints blue while a reply is streaming, so the box reads as busy without extra text.
    <Box borderStyle="round" borderColor={disabled ? BLUE : DIM} paddingX={1}>
      <Text color={BLUE}>{"❯ "}</Text>
      {disabled ? (
        <Text color={DIM}>{busyText ?? "waiting for reply… (esc to cancel)"}</Text>
      ) : (
        <TextInput
          value={value}
          onChange={(v) => {
            // A fast-typed Enter or pasted \r/\n can land in the same Ink input batch as other
            // keystrokes, so key.return never fires — catch the literal character instead.
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
