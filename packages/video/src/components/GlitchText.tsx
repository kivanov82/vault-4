import React from "react";
import { useCurrentFrame, random } from "remotion";
import { theme } from "../theme";

/**
 * Big title with chromatic-aberration glitch — the app's `glitch-hover` effect,
 * but driven by frame so it animates on its own. Glitches hardest right after
 * `appearAt`, then settles.
 */
export const GlitchText: React.FC<{
  text: string;
  fontSize?: number;
  appearAt?: number;
}> = ({ text, fontSize = 180, appearAt = 0 }) => {
  const frame = useCurrentFrame();
  const since = frame - appearAt;
  // Intensity decays over ~30 frames after appearing.
  const intensity = Math.max(0, 1 - since / 30);
  const jx = (random(`x${Math.floor(frame / 2)}`) - 0.5) * 18 * intensity;
  const jy = (random(`y${Math.floor(frame / 2)}`) - 0.5) * 6 * intensity;
  const showGlitch = since >= 0;

  const base: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    fontFamily: theme.fontMono,
    fontSize,
    fontWeight: 800,
    letterSpacing: 6,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  if (!showGlitch) return null;

  return (
    <div style={{ position: "relative", width: "100%", height: fontSize * 1.2 }}>
      <div style={{ ...base, color: theme.red, opacity: 0.6 * intensity, transform: `translate(${-jx}px, ${jy}px)` }}>
        {text}
      </div>
      <div style={{ ...base, color: theme.cyan, opacity: 0.6 * intensity, transform: `translate(${jx}px, ${-jy}px)` }}>
        {text}
      </div>
      <div style={{ ...base, color: theme.greenBright, textShadow: `0 0 30px ${theme.greenGlow}` }}>
        {text}
      </div>
    </div>
  );
};
