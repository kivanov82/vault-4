import React from "react";
import { theme } from "../theme";

const Corner: React.FC<{ pos: "tl" | "tr" | "bl" | "br" }> = ({ pos }) => {
  const base: React.CSSProperties = {
    position: "absolute",
    width: 28,
    height: 28,
    borderColor: theme.green,
    boxShadow: `0 0 12px ${theme.greenGlow}`,
  };
  const map: Record<typeof pos, React.CSSProperties> = {
    tl: { top: 0, left: 0, borderTop: "2px solid", borderLeft: "2px solid" },
    tr: { top: 0, right: 0, borderTop: "2px solid", borderRight: "2px solid" },
    bl: { bottom: 0, left: 0, borderBottom: "2px solid", borderLeft: "2px solid" },
    br: { bottom: 0, right: 0, borderBottom: "2px solid", borderRight: "2px solid" },
  };
  return <div style={{ ...base, ...map[pos] }} />;
};

/**
 * Bordered terminal panel with glowing corner brackets — the app's
 * `terminal-border` + `corner-decorations` look.
 */
export const TerminalFrame: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => {
  return (
    <div
      style={{
        position: "relative",
        border: `1px solid ${theme.greenDim}`,
        background:
          "linear-gradient(180deg, oklch(0.10 0.015 142 / 0.85), oklch(0.07 0.01 142 / 0.85))",
        boxShadow: `inset 0 0 60px oklch(0.2 0.05 142 / 0.25), 0 0 40px ${theme.greenGlow}`,
        ...style,
      }}
    >
      <Corner pos="tl" />
      <Corner pos="tr" />
      <Corner pos="bl" />
      <Corner pos="br" />
      {children}
    </div>
  );
};
