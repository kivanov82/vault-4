import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig, random } from "remotion";
import { theme } from "../theme";

const GLYPHS = "01░▒▓<>/$#*+=ACEFHKLNRTXZ".split("");

/**
 * Faint matrix-rain backdrop. Deterministic via Remotion's seeded random()
 * so every render produces identical frames.
 */
export const MatrixRain: React.FC<{ columns?: number; opacity?: number }> = ({
  columns = 48,
  opacity = 0.12,
}) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();

  const cols = useMemo(
    () =>
      new Array(columns).fill(0).map((_, i) => ({
        x: (i / columns) * width,
        speed: 40 + random(`s${i}`) * 90, // px per second
        offset: random(`o${i}`) * height,
        len: 6 + Math.floor(random(`l${i}`) * 10),
        glyphSeed: i,
      })),
    [columns, width, height]
  );

  return (
    <div style={{ position: "absolute", inset: 0, opacity, overflow: "hidden" }}>
      {cols.map((c, i) => {
        const y = ((c.offset + (frame / fps) * c.speed) % (height + 200)) - 100;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: c.x,
              top: y,
              fontFamily: theme.fontMono,
              fontSize: 18,
              lineHeight: "20px",
              color: theme.green,
              textShadow: `0 0 8px ${theme.greenGlow}`,
              whiteSpace: "pre",
            }}
          >
            {new Array(c.len)
              .fill(0)
              .map((_, j) => {
                const g =
                  GLYPHS[
                    Math.floor(
                      random(`g${c.glyphSeed}-${j}-${Math.floor(frame / 6)}`) *
                        GLYPHS.length
                    )
                  ];
                return (
                  <div key={j} style={{ opacity: 1 - j / c.len }}>
                    {g}
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
};
