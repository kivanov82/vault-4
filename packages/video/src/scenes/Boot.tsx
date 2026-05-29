import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { theme } from "../theme";
import { TypingText } from "../components/TypingText";
import { GlitchText } from "../components/GlitchText";

const LINES = [
  "initializing vault-4 core",
  "connecting to hyperliquid",
  "loading claude ranking engine",
  "syncing on-chain vault state",
];

const BootLine: React.FC<{ text: string; index: number }> = ({ text, index }) => {
  const frame = useCurrentFrame();
  const delay = 6 + index * 16;
  const okAt = delay + 13;
  const showOk = frame >= okAt;
  return (
    <div
      style={{
        fontFamily: theme.fontMono,
        fontSize: 28,
        color: theme.green,
        display: "flex",
        gap: 10,
        marginBottom: 14,
      }}
    >
      <span style={{ color: theme.greenDim }}>{">"}</span>
      <TypingText text={text} delay={delay} cps={42} color={theme.green} />
      <span style={{ flex: 1, color: theme.greenDim, overflow: "hidden", whiteSpace: "nowrap" }}>
        {" "}
        {".".repeat(40)}
      </span>
      <span
        style={{
          color: theme.greenBright,
          opacity: showOk ? 1 : 0,
          textShadow: `0 0 12px ${theme.greenGlow}`,
        }}
      >
        [OK]
      </span>
    </div>
  );
};

export const Boot: React.FC = () => {
  const frame = useCurrentFrame();
  const logoAt = 62;
  // Boot lines fade/lift up as the logo takes over.
  const listShift = interpolate(frame, [logoAt - 6, logoAt + 8], [0, -60], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const listFade = interpolate(frame, [logoAt - 6, logoAt + 8], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const taglineFade = interpolate(frame, [logoAt + 22, logoAt + 34], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div style={{ width: 1100, position: "relative" }}>
        <div style={{ opacity: listFade, transform: `translateY(${listShift}px)` }}>
          {LINES.map((l, i) => (
            <BootLine key={l} text={l} index={i} />
          ))}
        </div>

        {frame >= logoAt && (
          <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
            <GlitchText text="VAULT-4" fontSize={170} appearAt={logoAt} />
            <div
              style={{
                marginTop: 210,
                fontFamily: theme.fontMono,
                fontSize: 30,
                letterSpacing: 8,
                color: theme.cyan,
                opacity: taglineFade,
                textShadow: `0 0 16px ${theme.cyanGlow}`,
              }}
            >
              NON-CUSTODIAL · FULLY AUTOMATED
            </div>
          </AbsoluteFill>
        )}
      </div>
    </AbsoluteFill>
  );
};
