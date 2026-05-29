import { theme } from "../theme";

export const colorOf = (c: string) =>
  c === "cyan"
    ? theme.cyan
    : c === "amber"
    ? theme.amber
    : c === "red"
    ? theme.red
    : theme.green;

export const fmt = (n: number, decimals: number) =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

/** Signed percentage string, e.g. +16.6% / -18.9%. */
export const signedPct = (n: number, decimals = 1) =>
  `${n > 0 ? "+" : ""}${fmt(n, decimals)}%`;
