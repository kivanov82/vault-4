import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";
import { theme } from "../theme";
import { GlitchText } from "../components/GlitchText";

const Badge: React.FC<{ text: string; index: number; color: string }> = ({
  text,
  index,
  color,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame: frame - (30 + index * 8),
    fps,
    config: { damping: 200 },
  });
  return (
    <span
      style={{
        fontFamily: theme.fontMono,
        fontSize: 22,
        letterSpacing: 3,
        color,
        border: `1px solid ${color}`,
        padding: "10px 20px",
        opacity: enter * 0.95,
        transform: `translateY(${(1 - enter) * 16}px)`,
        boxShadow: `0 0 18px ${color}`,
      }}
    >
      {text}
    </span>
  );
};

export const CTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const urlEnter = spring({ frame: frame - 58, fps, config: { damping: 200 } });
  const caretOn = Math.floor(frame / 8) % 2 === 0;
  // Subtle pulsing glow on the URL.
  const pulse = 0.7 + 0.3 * Math.sin(frame / 6);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
      }}
    >
      <div style={{ height: 200, width: 1000, position: "relative" }}>
        <GlitchText text="VAULT-4" fontSize={150} appearAt={0} />
      </div>

      <div style={{ display: "flex", gap: 18, marginTop: 30 }}>
        <Badge text="NON-CUSTODIAL" index={0} color={theme.cyan} />
        <Badge text="FULLY AUTOMATED" index={1} color={theme.green} />
        <Badge text="AI-RANKED" index={2} color={theme.amber} />
      </div>

      <div
        style={{
          marginTop: 64,
          fontFamily: theme.fontMono,
          fontSize: 40,
          color: theme.greenBright,
          opacity: urlEnter,
          textShadow: `0 0 ${20 * pulse}px ${theme.greenGlow}`,
          transform: `translateY(${(1 - urlEnter) * 18}px)`,
        }}
      >
        <span style={{ color: theme.greenDim }}>{"> "}</span>
        vault-4.xyz
        <span style={{ opacity: caretOn ? 1 : 0, marginLeft: 4 }}>▋</span>
      </div>
    </AbsoluteFill>
  );
};
