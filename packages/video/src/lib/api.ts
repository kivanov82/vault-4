/**
 * Live data layer. Fetched at render time in Root.tsx's calcMetadata (runs in
 * both Remotion Studio and `remotion render`). Falls back to a baked-in
 * snapshot so the video always renders, even offline / if the API is down.
 */

export const API_BASE =
  process.env.REMOTION_VAULT_API_BASE_URL ??
  "https://vault-4-s6qnbk6izq-ew.a.run.app";

export type ChartPoint = { t: number; v: number };

export type LiveData = {
  /** Per the user's request: TVL shown as 30d % change, never absolute. */
  tvlChange30dPct: number | null;
  pnlChange30dPct: number | null;
  pnlChange60dPct: number | null;
  pnlChangeInceptionPct: number | null;
  winRatePct: number | null;
  maxDrawdownPct: number | null;
  daysSinceInception: number;
  pnlPoints: ChartPoint[];
};

/** Snapshot captured 2026-05-29 — used if the live fetch fails. */
export const FALLBACK: LiveData = {
  tvlChange30dPct: 69.8,
  pnlChange30dPct: 16.57,
  pnlChange60dPct: 32.83,
  pnlChangeInceptionPct: 9.67,
  winRatePct: 60,
  maxDrawdownPct: -18.88,
  daysSinceInception: 142,
  pnlPoints: [
    { t: 0, v: 22.6 }, { t: 1, v: 21.4 }, { t: 2, v: 33.5 }, { t: 3, v: 101.2 },
    { t: 4, v: 111.3 }, { t: 5, v: 84.1 }, { t: 6, v: 114.1 }, { t: 7, v: 107.9 },
    { t: 8, v: 138.2 }, { t: 9, v: 162.2 }, { t: 10, v: 125.3 }, { t: 11, v: 79.2 },
    { t: 12, v: 12.3 }, { t: 13, v: 19.2 }, { t: 14, v: 35.0 }, { t: 15, v: 38.0 },
    { t: 16, v: 56.9 }, { t: 17, v: 80.7 }, { t: 18, v: 298.9 }, { t: 19, v: 202.9 },
    { t: 20, v: 122.0 }, { t: 21, v: 168.1 }, { t: 22, v: 356.0 }, { t: 23, v: 256.3 },
  ],
};

const pct = (n: unknown): number | null =>
  typeof n === "number" && isFinite(n) ? n : null;

export async function fetchLiveData(): Promise<LiveData> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const [mRes, pRes] = await Promise.all([
      fetch(`${API_BASE}/api/metrics`, { signal: ctrl.signal }),
      fetch(`${API_BASE}/api/portfolio`, { signal: ctrl.signal }),
    ]);
    clearTimeout(timer);
    const m = await mRes.json();
    const p = await pRes.json();

    // Derive a true 30d TVL % change from the USD delta + current TVL.
    let tvlChange30dPct: number | null = null;
    if (typeof m?.tvlUsd === "number" && typeof m?.tvlChange30dUsd === "number") {
      const prior = m.tvlUsd - m.tvlChange30dUsd;
      if (prior > 0) tvlChange30dPct = (m.tvlChange30dUsd / prior) * 100;
    }

    const points: ChartPoint[] = Array.isArray(p?.history?.pnl?.points)
      ? p.history.pnl.points.map((pt: any, i: number) => ({
          t: i,
          v: Number(pt.value),
        }))
      : FALLBACK.pnlPoints;

    return {
      tvlChange30dPct: tvlChange30dPct ?? FALLBACK.tvlChange30dPct,
      pnlChange30dPct: pct(m?.pnlChange30dPct) ?? FALLBACK.pnlChange30dPct,
      pnlChange60dPct: pct(m?.pnlChange60dPct) ?? FALLBACK.pnlChange60dPct,
      pnlChangeInceptionPct:
        pct(m?.pnlChangeInceptionPct) ?? FALLBACK.pnlChangeInceptionPct,
      winRatePct: pct(m?.winRatePct) ?? FALLBACK.winRatePct,
      maxDrawdownPct: pct(m?.maxDrawdownPct) ?? FALLBACK.maxDrawdownPct,
      daysSinceInception:
        typeof m?.daysSinceInception === "number"
          ? m.daysSinceInception
          : FALLBACK.daysSinceInception,
      pnlPoints: points.length >= 2 ? points : FALLBACK.pnlPoints,
    };
  } catch {
    return FALLBACK;
  }
}
