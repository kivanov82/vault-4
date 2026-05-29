import React from "react";
import { useCurrentFrame } from "remotion";
import { theme } from "../theme";

/**
 * Typewriter reveal with a blinking block cursor — the app's TypingText effect.
 * `cps` = characters per second. `delay` = frames before typing starts.
 */
export const TypingText: React.FC<{
  text: string;
  cps?: number;
  delay?: number;
  color?: string;
  style?: React.CSSProperties;
}> = ({ text, cps = 28, delay = 0, color = theme.green, style }) => {
  const frame = useCurrentFrame();
  const fps = 30;
  const elapsed = Math.max(0, frame - delay);
  const shown = Math.min(text.length, Math.floor((elapsed / fps) * cps));
  const done = shown >= text.length;
  const cursorOn = Math.floor(frame / 8) % 2 === 0;

  return (
    <span style={{ color, fontFamily: theme.fontMono, ...style }}>
      {text.slice(0, shown)}
      <span
        style={{
          opacity: done ? (cursorOn ? 1 : 0) : 1,
          color,
          marginLeft: 2,
        }}
      >
        ▋
      </span>
    </span>
  );
};
