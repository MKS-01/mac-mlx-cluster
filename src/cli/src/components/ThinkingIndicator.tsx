import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { DIM } from "../theme";

const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const THINKING_WORDS = [
  "Pondering", "Noodling", "Ruminating", "Percolating", "Cogitating",
  "Marinating", "Contemplating", "Puzzling", "Mulling", "Synthesizing",
  "Conjuring", "Deliberating", "Untangling", "Simmering", "Churning",
];

function randomWord(): string {
  return THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)]!;
}

/** Shown between submit and the first streamed token — after that ChatView switches to the real text. */
export function ThinkingIndicator() {
  const [frame, setFrame] = useState(0);
  const [word, setWord] = useState(randomWord);

  useEffect(() => {
    const spin = setInterval(() => setFrame((f) => (f + 1) % SPIN_FRAMES.length), 80);
    const swap = setInterval(() => setWord(randomWord()), 1800);
    return () => {
      clearInterval(spin);
      clearInterval(swap);
    };
  }, []);

  return (
    <Text color={DIM}>
      {SPIN_FRAMES[frame]} {word}…
    </Text>
  );
}
