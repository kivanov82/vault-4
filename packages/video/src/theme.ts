/**
 * Design tokens ported verbatim from packages/web/app/globals.css.
 * Keep these in sync with the web app so the video matches the product.
 */
export const theme = {
  greenBright: "oklch(0.85 0.22 142)",
  green: "oklch(0.75 0.18 142)",
  greenDim: "oklch(0.45 0.12 142)",
  greenGlow: "oklch(0.65 0.15 142 / 0.5)",
  cyanBright: "oklch(0.85 0.18 195)",
  cyan: "oklch(0.75 0.15 195)",
  cyanDim: "oklch(0.5 0.1 195)",
  cyanGlow: "oklch(0.65 0.12 195 / 0.5)",
  amber: "oklch(0.78 0.16 75)",
  amberDim: "oklch(0.55 0.12 75)",
  amberGlow: "oklch(0.65 0.14 75 / 0.5)",
  red: "oklch(0.65 0.2 25)",
  redGlow: "oklch(0.55 0.18 25 / 0.5)",
  black: "oklch(0.05 0 0)",
  dark: "oklch(0.08 0.01 142)",
  surface: "oklch(0.12 0.015 142)",
  fontMono: '"Fira Code", "JetBrains Mono", monospace',
} as const;
