import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";
import { theme } from "../theme";
import { TypingText } from "../components/TypingText";

const STEPS = [
  { n: "01", title: "DISCOVER", body: "Scan every Hyperliquid vault. Filter by TVL, age, activity.", glyph: "⌖" },
  { n: "02", title: "RANK", body: "Claude scores & ranks candidates against live market data.", glyph: "▲" },
  { n: "03", title: "REBALANCE", body: "Auto-allocate every 2 days. Stop-loss & risk limits enforced.", glyph: "↻" },
];

const Step: React.FC<{ step: (typeof STEPS)[number]; index: number }> = ({
  step,
  index,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const start = 12 + index * 30;
  const enter = spring({ frame: frame - start, fps, config: { damping: 200 } });

  return (
    <div
      style={{
        flex: 1,
        position: "relative",
        padding: "40px 34px",
        border: `1px solid ${theme.greenDim}`,
        background: "oklch(0.10 0.015 142 / 0.55)",
        boxShadow: `inset 0 0 36px oklch(0.2 0.05 142 / 0.18)`,
        opacity: enter,
        transform: `translateY(${(1 - enter) * 30}px)`,
      }}
    >
      <div
        style={{
          fontFamily: theme.fontMono,
          fontSize: 64,
          color: theme.green,
          textShadow: `0 0 22px ${theme.greenGlow}`,
          lineHeight: 1,
        }}
      >
        {step.glyph}
      </div>
      <div
        style={{
          fontFamily: theme.fontMono,
          color: theme.cyanDim,
          fontSize: 20,
          marginTop: 18,
        }}
      >
        STEP {step.n}
      </div>
      <div
        style={{
          fontFamily: theme.fontMono,
          color: theme.greenBright,
          fontSize: 38,
          fontWeight: 700,
          letterSpacing: 2,
          margin: "6px 0 16px",
        }}
      >
        {step.title}
      </div>
      <div
        style={{
          fontFamily: theme.fontMono,
          color: theme.green,
          opacity: 0.8,
          fontSize: 21,
          lineHeight: 1.5,
          minHeight: 64,
        }}
      >
        {frame >= start + 6 ? (
          <TypingText text={step.body} delay={start + 6} cps={48} color={theme.green} />
        ) : null}
      </div>
    </div>
  );
};

export const HowItWorks: React.FC = () => {
  const frame = useCurrentFrame();
  const headerFade = interpolate(frame, [0, 12], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        padding: 100,
        flexDirection: "column",
      }}
    >
      <div
        style={{
          fontFamily: theme.fontMono,
          fontSize: 28,
          color: theme.greenBright,
          letterSpacing: 4,
          marginBottom: 40,
          opacity: headerFade,
        }}
      >
        <span style={{ color: theme.greenDim }}>{"// "}</span>HOW IT WORKS
      </div>
      <div style={{ display: "flex", gap: 26, width: "100%", maxWidth: 1560 }}>
        {STEPS.map((s, i) => (
          <React.Fragment key={s.n}>
            <Step step={s} index={i} />
            {i < STEPS.length - 1 && (
              <div
                style={{
                  alignSelf: "center",
                  color: theme.greenDim,
                  fontSize: 48,
                  fontFamily: theme.fontMono,
                  opacity: interpolate(
                    frame,
                    [12 + i * 30 + 20, 12 + i * 30 + 32],
                    [0, 1],
                    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
                  ),
                }}
              >
                ▸
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </AbsoluteFill>
  );
};
