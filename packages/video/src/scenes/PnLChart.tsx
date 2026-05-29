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
import { signedPct } from "../lib/format";
import type { LiveData } from "../lib/api";

const W = 1360;
const H = 460;
const PAD = 24;

export const PnLChart: React.FC<{ live: LiveData }> = ({ live }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pts = live.pnlPoints;

  const panelEnter = spring({ frame: frame - 4, fps, config: { damping: 200 } });

  const vals = pts.map((p) => p.v);
  const min = Math.min(...vals, 0);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const n = pts.length;

  const x = (i: number) => PAD + (i / (n - 1)) * (W - PAD * 2);
  const y = (v: number) => PAD + (1 - (v - min) / span) * (H - PAD * 2);

  const lineD = pts.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.v)}`).join(" ");
  const areaD = `${lineD} L${x(n - 1)},${H - PAD} L${x(0)},${H - PAD} Z`;

  // Sweep reveal: a clip rect grows left→right over frames [start..end].
  const start = 26;
  const end = 110;
  const p = interpolate(frame, [start, end], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const revealW = PAD + p * (W - PAD * 2);

  // Leading dot position (lerp between adjacent points).
  const fi = p * (n - 1);
  const lo = Math.floor(fi);
  const hi = Math.min(n - 1, lo + 1);
  const f = fi - lo;
  const dotX = x(lo) + (x(hi) - x(lo)) * f;
  const dotY = y(pts[lo].v) + (y(pts[hi].v) - y(pts[lo].v)) * f;

  const headline = live.pnlChange60dPct ?? 0;
  const headlineColor = headline >= 0 ? theme.greenBright : theme.red;
  const headlineP = interpolate(frame, [start, end], [0, headline], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  return (
    <AbsoluteFill
      style={{ justifyContent: "center", alignItems: "center", padding: 90 }}
    >
      <TerminalFrame
        style={{
          width: "100%",
          maxWidth: 1520,
          padding: 56,
          opacity: panelEnter,
          transform: `translateY(${(1 - panelEnter) * 24}px)`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 16,
            marginBottom: 28,
            fontFamily: theme.fontMono,
          }}
        >
          <span style={{ color: theme.greenDim, fontSize: 22 }}>$</span>
          <span style={{ color: theme.greenBright, fontSize: 26, letterSpacing: 2 }}>
            PORTFOLIO_PNL
          </span>
          <span style={{ color: theme.cyanDim, fontSize: 20 }}>// 60D WINDOW</span>
          <span
            style={{
              marginLeft: "auto",
              color: headlineColor,
              fontSize: 44,
              fontWeight: 700,
              textShadow: `0 0 18px ${headlineColor}`,
            }}
          >
            {signedPct(headlineP, 1)}
          </span>
        </div>

        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
          <defs>
            <linearGradient id="pnlArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={theme.green} stopOpacity={0.35} />
              <stop offset="100%" stopColor={theme.green} stopOpacity={0} />
            </linearGradient>
            <clipPath id="reveal">
              <rect x="0" y="0" width={revealW} height={H} />
            </clipPath>
          </defs>

          {/* gridlines */}
          {[0.25, 0.5, 0.75].map((g) => (
            <line
              key={g}
              x1={PAD}
              x2={W - PAD}
              y1={PAD + g * (H - PAD * 2)}
              y2={PAD + g * (H - PAD * 2)}
              stroke={theme.greenDim}
              strokeOpacity={0.25}
              strokeDasharray="4 8"
            />
          ))}
          {/* zero baseline */}
          <line
            x1={PAD}
            x2={W - PAD}
            y1={y(0)}
            y2={y(0)}
            stroke={theme.greenDim}
            strokeOpacity={0.5}
          />

          <g clipPath="url(#reveal)">
            <path d={areaD} fill="url(#pnlArea)" />
            <path
              d={lineD}
              fill="none"
              stroke={theme.greenBright}
              strokeWidth={3}
              strokeLinejoin="round"
              style={{ filter: `drop-shadow(0 0 6px ${theme.greenGlow})` }}
            />
          </g>

          {/* leading dot */}
          <circle cx={dotX} cy={dotY} r={9} fill={theme.greenBright} />
          <circle cx={dotX} cy={dotY} r={18} fill={theme.green} opacity={0.25} />
        </svg>
      </TerminalFrame>
    </AbsoluteFill>
  );
};
