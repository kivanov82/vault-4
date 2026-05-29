import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  Easing,
} from "remotion";
import { theme } from "../theme";
import { TerminalFrame } from "../components/TerminalFrame";
import { TypingText } from "../components/TypingText";
import { colorOf, signedPct, fmt } from "../lib/format";
import type { LiveData } from "../lib/api";

type Metric = {
  label: string;
  value: number;
  color: string;
  render: (v: number) => string;
};

const buildMetrics = (live: LiveData): Metric[] => [
  {
    label: "TVL_30D",
    value: live.tvlChange30dPct ?? 0,
    color: "cyan",
    render: (v) => signedPct(v, 1),
  },
  {
    label: "30D_PNL",
    value: live.pnlChange30dPct ?? 0,
    color: (live.pnlChange30dPct ?? 0) >= 0 ? "green" : "red",
    render: (v) => signedPct(v, 1),
  },
  {
    label: "60D_PNL",
    value: live.pnlChange60dPct ?? 0,
    color: (live.pnlChange60dPct ?? 0) >= 0 ? "green" : "red",
    render: (v) => signedPct(v, 1),
  },
  {
    label: "WIN_RATE",
    value: live.winRatePct ?? 0,
    color: "green",
    render: (v) => `${fmt(v, 0)}%`,
  },
];

const MetricCard: React.FC<{ metric: Metric; index: number }> = ({
  metric,
  index,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const start = 38 + index * 9;

  const enter = spring({
    frame: frame - start,
    fps,
    config: { damping: 200, mass: 0.6 },
  });
  const progress = interpolate(frame, [start, start + 34], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const c = colorOf(metric.color);

  return (
    <div
      style={{
        flex: 1,
        padding: "26px 28px",
        border: `1px solid ${theme.greenDim}`,
        background: "oklch(0.10 0.015 142 / 0.6)",
        boxShadow: `inset 0 0 30px oklch(0.2 0.05 142 / 0.2)`,
        opacity: enter,
        transform: `translateY(${(1 - enter) * 24}px)`,
      }}
    >
      <div
        style={{
          color: theme.greenDim,
          fontSize: 18,
          letterSpacing: 2,
          fontFamily: theme.fontMono,
        }}
      >
        :: {metric.label}
      </div>
      <div
        style={{
          color: c,
          fontSize: 56,
          fontWeight: 700,
          marginTop: 10,
          fontFamily: theme.fontMono,
          textShadow: `0 0 18px ${c}`,
        }}
      >
        {metric.render(metric.value * progress)}
      </div>
    </div>
  );
};

export const HeroMetrics: React.FC<{ live: LiveData }> = ({ live }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const metrics = buildMetrics(live);

  const labelBlink = Math.floor(frame / 16) % 2 === 0;
  const panelEnter = spring({ frame: frame - 6, fps, config: { damping: 200 } });

  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", padding: 90 }}
    >
      <TerminalFrame
        style={{
          width: "100%",
          maxWidth: 1500,
          padding: 64,
          opacity: panelEnter,
          transform: `scale(${0.96 + panelEnter * 0.04})`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontFamily: theme.fontMono,
            fontSize: 22,
          }}
        >
          <span style={{ color: theme.green, opacity: labelBlink ? 1 : 0.3 }}>●</span>
          <span style={{ color: theme.greenBright, letterSpacing: 3 }}>VAULT-4</span>
          <span style={{ color: theme.cyanDim }}>// LIVE PERFORMANCE</span>
          <span style={{ marginLeft: "auto", color: theme.cyan, fontSize: 18 }}>
            DAY {live.daysSinceInception}
          </span>
        </div>

        <div
          style={{
            height: 1,
            background: theme.greenDim,
            opacity: 0.4,
            margin: "26px 0 34px",
          }}
        />

        <div style={{ fontSize: 40, marginBottom: 44, minHeight: 52 }}>
          <span style={{ color: theme.greenDim, fontFamily: theme.fontMono }}>{"> "}</span>
          <TypingText
            text="AUTONOMOUS HYPERLIQUID VAULTS"
            delay={14}
            cps={26}
            color={theme.greenBright}
            style={{ fontSize: 40, fontWeight: 700, letterSpacing: 2 }}
          />
        </div>

        <div style={{ display: "flex", gap: 22 }}>
          {metrics.map((m, i) => (
            <MetricCard key={m.label} metric={m} index={i} />
          ))}
        </div>
      </TerminalFrame>
    </AbsoluteFill>
  );
};
