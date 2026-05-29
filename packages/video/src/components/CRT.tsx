import React from "react";
import { useCurrentFrame, interpolate } from "remotion";

/**
 * CRT overlay: scanlines + subtle flicker + vignette burn.
 * Mirrors the .crt effect in the web app's globals.css.
 * Render this LAST (on top of all content), pointer-events: none.
 */
export const CRT: React.FC = () => {
  const frame = useCurrentFrame();
  // Gentle flicker, deterministic (frame-based) so renders are reproducible.
  const flicker =
    0.96 +
    0.04 * Math.sin(frame * 0.9) * Math.cos(frame * 0.37 + 1.3);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        opacity: flicker,
      }}
    >
      {/* Scanlines */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(0,0,0,0) 0px, rgba(0,0,0,0) 2px, rgba(0,0,0,0.18) 3px, rgba(0,0,0,0.18) 4px)",
          mixBlendMode: "multiply",
        }}
      />
      {/* Moving scan beam */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          height: 180,
          top: `${interpolate(frame % 150, [0, 150], [-15, 115])}%`,
          background:
            "linear-gradient(180deg, rgba(120,255,180,0) 0%, rgba(120,255,180,0.05) 50%, rgba(120,255,180,0) 100%)",
        }}
      />
      {/* Vignette */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%)",
        }}
      />
    </div>
  );
};
