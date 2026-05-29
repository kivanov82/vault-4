import React from "react";
import {
  AbsoluteFill,
  Audio,
  Series,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from "remotion";
import { theme } from "./theme";
import { MatrixRain } from "./components/MatrixRain";
import { CRT } from "./components/CRT";
import { Boot } from "./scenes/Boot";
import { HeroMetrics } from "./scenes/HeroMetrics";
import { PnLChart } from "./scenes/PnLChart";
import { HowItWorks } from "./scenes/HowItWorks";
import { CTA } from "./scenes/CTA";
import { FALLBACK, type LiveData } from "./lib/api";

/** Fades a scene in at its start and out at its end (frame is per-sequence). */
const SceneFade: React.FC<{ children: React.ReactNode; fade?: number }> = ({
  children,
  fade = 10,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const opacity = interpolate(
    frame,
    [0, fade, durationInFrames - fade, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

export const DURATIONS = {
  boot: 100,
  hero: 165,
  chart: 150,
  how: 165,
  cta: 130,
};
export const TOTAL_FRAMES = Object.values(DURATIONS).reduce((a, b) => a + b, 0);

export const Promo: React.FC<{ live?: LiveData }> = ({ live = FALLBACK }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.black }}>
      {/* Original procedural synthwave bed (scripts/gen-music.js). Section
          dynamics + outro fade are baked into the track; this is the master level. */}
      <Audio src={staticFile("music.mp3")} volume={0.7} />

      {/* Continuous backdrop across all scenes */}
      <MatrixRain opacity={0.08} />
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at 50% 42%, oklch(0.3 0.1 142 / 0.22), transparent 62%)",
        }}
      />

      <Series>
        <Series.Sequence durationInFrames={DURATIONS.boot}>
          <SceneFade>
            <Boot />
          </SceneFade>
        </Series.Sequence>
        <Series.Sequence durationInFrames={DURATIONS.hero}>
          <SceneFade>
            <HeroMetrics live={live} />
          </SceneFade>
        </Series.Sequence>
        <Series.Sequence durationInFrames={DURATIONS.chart}>
          <SceneFade>
            <PnLChart live={live} />
          </SceneFade>
        </Series.Sequence>
        <Series.Sequence durationInFrames={DURATIONS.how}>
          <SceneFade>
            <HowItWorks />
          </SceneFade>
        </Series.Sequence>
        <Series.Sequence durationInFrames={DURATIONS.cta}>
          <SceneFade>
            <CTA />
          </SceneFade>
        </Series.Sequence>
      </Series>

      {/* CRT overlay sits above everything */}
      <CRT />
    </AbsoluteFill>
  );
};
