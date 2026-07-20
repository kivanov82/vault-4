// VaultFeatureService — deterministic feature engine (WP-A).
// All arithmetic for the vault-ranking pipeline lives here: per-vault features,
// universe-wide robust z-scores, and stage-specific quant scores. Pure functions
// only — no I/O, no Date.now(), no env access. `nowMs` is always a parameter.
// See dev-instructions/00-OVERVIEW.md §4 (types) and §5 (API + formulas).

import type {
    RegimeFlags,
    VaultQuantFeatures,
    VaultQuantScore,
    VaultUniverseScores,
    VaultRawData,
} from "./featureTypes";

const DAY_MS = 86_400_000;

/** Number(...) with a non-finite guard: returns null for NaN/Infinity/garbage. */
function num(v: any): number | null {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** Median of a non-empty numeric vector (assumes finite values). */
function median(sorted: number[]): number {
    const n = sorted.length;
    const mid = Math.floor(n / 2);
    if (n % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}

/** Round to 1 decimal place. */
function round1(x: number): number {
    return Math.round(x * 10) / 10;
}

function clamp(x: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, x));
}

export class VaultFeatureService {
    /** All arithmetic for the universe in one pass. Pure: no I/O, no Date.now(). */
    static computeUniverse(
        rawData: VaultRawData[],
        marketData: any,
        nowMs: number
    ): VaultUniverseScores {
        const regime = VaultFeatureService.computeRegimeFlags(marketData);
        const features = rawData.map((r) => VaultFeatureService.computeFeatures(r, nowMs));

        // Feature keys that participate in the base/overlay formulas. z is computed
        // ONCE over the whole universe per feature — never per batch. This is the
        // entire point of the refactor.
        const zKeys: Array<keyof VaultQuantFeatures> = [
            "weekRt",
            "pnl7Rt",
            "dayRt",
            "unrealRt",
            "winrate7d",
            "winrate30d",
            "pnl30Rt",
            "pnlSd30d",
            "monthMaxDdRt",
            "netRt",
            "altsRt",
            "pnlSd7d",
            "grossLev",
            "shortRatio7d",
            "btcRt",
        ];

        const zByKey: Record<string, Array<number | null>> = {};
        for (const key of zKeys) {
            const vector = features.map((f) => f[key] as number | null);
            zByKey[key] = VaultFeatureService.robustZ(vector);
        }

        // z at index i, treating null as a 0 contribution to the weighted sum.
        const z = (key: string, i: number): number => {
            const v = zByKey[key][i];
            return v === null ? 0 : v;
        };

        const flag = (b: boolean): number => (b ? 1 : 0);

        const scoring: VaultQuantScore[] = [];
        const ranking: VaultQuantScore[] = [];

        for (let i = 0; i < features.length; i++) {
            const f = features[i];

            const base1 =
                0.1 * z("weekRt", i) +
                0.2 * z("pnl7Rt", i) +
                0.15 * z("dayRt", i) +
                0.1 * z("unrealRt", i) +
                0.15 * z("winrate30d", i) +
                0.2 * z("pnl30Rt", i) -
                0.15 * z("pnlSd30d", i) -
                0.1 * z("monthMaxDdRt", i);

            const base2 =
                0.15 * z("weekRt", i) +
                0.3 * z("pnl7Rt", i) +
                0.25 * z("dayRt", i) +
                0.1 * z("unrealRt", i) +
                0.1 * z("winrate7d", i) +
                0.1 * z("pnl30Rt", i) -
                0.1 * z("pnlSd30d", i);

            // Overlay shared by both stages (flag = 1 when true else 0).
            const overlay =
                0.15 * flag(regime.bearFlag) * -z("netRt", i) +
                0.1 * flag(regime.fundingPos) * -z("netRt", i) +
                0.15 * flag(regime.domHigh) * -z("altsRt", i) -
                0.1 * flag(regime.fearHigh) * z("pnlSd7d", i) +
                0.1 * flag(regime.riskOn) * z("netRt", i) +
                0.1 * flag(regime.altSeason) * z("altsRt", i) -
                0.1 * flag(regime.crowdedLongs) * z("grossLev", i) +
                0.1 * flag(regime.bearFlag) * z("shortRatio7d", i) +
                0.1 * flag(regime.riskOn) * -z("shortRatio7d", i) +
                0.1 * flag(regime.bearFlag) * -z("btcRt", i) +
                0.1 * flag(regime.riskOn) * z("btcRt", i);

            // Stage-2 overlay additionally adds the direct (non-z) mmProxy term.
            const overlay2 = overlay + 0.05 * f.mmProxy;

            const { alignmentPenalty, aligned } = VaultFeatureService.alignment(
                regime.regime,
                f.direction
            );

            scoring.push(
                VaultFeatureService.buildScore(f, base1, overlay, alignmentPenalty, aligned)
            );
            ranking.push(
                VaultFeatureService.buildScore(f, base2, overlay2, alignmentPenalty, aligned)
            );
        }

        return { regime, features, scoring, ranking };
    }

    static computeRegimeFlags(marketData: any): RegimeFlags {
        const btc7 = num(marketData?.btc_7d_change);
        const eth7 = num(marketData?.eth_7d_change);
        const funding = num(marketData?.funding_btc);
        const dominance = num(marketData?.dominance);
        const fear = num(marketData?.fearGreed);
        const lsr = num(marketData?.long_short_ratio);

        const bearFlag = btc7 !== null && btc7 < 0;
        const fundingPos = funding !== null && funding > 0;
        const domHigh = dominance !== null && dominance > 55;
        const fearHigh = fear !== null && fear <= 30;
        const riskOn = btc7 !== null && fear !== null && btc7 > 0 && fear > 50;
        const altSeason =
            eth7 !== null &&
            btc7 !== null &&
            dominance !== null &&
            eth7 > btc7 &&
            dominance < 50;
        const crowdedLongs = lsr !== null && lsr > 1.5;

        const regime: RegimeFlags["regime"] = riskOn
            ? "risk-on"
            : bearFlag
            ? "risk-off"
            : "neutral";

        return {
            bearFlag,
            fundingPos,
            domHigh,
            fearHigh,
            riskOn,
            altSeason,
            crowdedLongs,
            regime,
        };
    }

    static computeFeatures(raw: VaultRawData, nowMs: number): VaultQuantFeatures {
        const dataQuality: string[] = [];
        const candidate: any = raw?.candidate ?? {};

        const address = String(candidate.vaultAddress ?? "").toLowerCase();
        const name = String(candidate.name ?? "");
        const tvlNum = num(candidate.tvl);
        const tvl = tvlNum ?? 0;
        const validTvl = tvlNum !== null && tvlNum > 0;
        if (!validTvl) dataQuality.push("no_tvl");

        // ---- PnL series deltas (series are cumulative, already time-sorted) ----
        const pnls = Array.isArray(raw?.pnls) ? raw.pnls : [];
        const seriesValues = (keyword: string): number[] | null => {
            const matches = pnls.filter(
                (entry) =>
                    Array.isArray(entry) &&
                    typeof entry[0] === "string" &&
                    entry[0].toLowerCase().includes(keyword)
            );
            if (matches.length === 0) return null;
            const exact = matches.find((entry) => entry[0].toLowerCase() === keyword);
            const chosen = exact ?? matches[0];
            const points = Array.isArray(chosen[1]) ? chosen[1] : [];
            const vals: number[] = [];
            for (const pt of points) {
                const v = num(Array.isArray(pt) ? pt[1] : undefined);
                if (v !== null) vals.push(v);
            }
            return vals;
        };

        const dayVals = seriesValues("day");
        let dayPnl: number | null = null;
        if (dayVals && dayVals.length >= 2) {
            dayPnl = dayVals[dayVals.length - 1] - dayVals[0];
        } else {
            dataQuality.push("no_day_series");
        }

        const weekVals = seriesValues("week");
        let weekPnl: number | null = null;
        if (weekVals && weekVals.length >= 2) {
            weekPnl = weekVals[weekVals.length - 1] - weekVals[0];
        } else {
            dataQuality.push("no_week_series");
        }

        const monthVals = seriesValues("month");
        let monthPnl: number | null = null;
        let monthMaxDdRt: number | null = null;
        if (monthVals && monthVals.length >= 2) {
            monthPnl = monthVals[monthVals.length - 1] - monthVals[0];
            let peak = monthVals[0];
            let maxDd = 0;
            for (const v of monthVals) {
                if (v > peak) peak = v;
                const dd = peak - v;
                if (dd > maxDd) maxDd = dd;
            }
            monthMaxDdRt = validTvl ? maxDd / tvl : null;
        } else {
            dataQuality.push("no_month_series");
        }

        // allTime: a single point is fine (cumulative last value). No tag.
        const allTimeVals = seriesValues("alltime");
        const allTimePnl: number | null =
            allTimeVals && allTimeVals.length >= 1
                ? allTimeVals[allTimeVals.length - 1]
                : null;

        // ---- Trade windows ----
        const trades = Array.isArray(raw?.trades) ? raw.trades : [];
        const windowStats = (windowDays: number, tag: string) => {
            const lo = nowMs - windowDays * DAY_MS;
            const inWindow = trades.filter((t) => {
                const tm = num((t as any)?.time);
                return tm !== null && tm >= lo && tm <= nowMs;
            });
            const count = inWindow.length;
            if (count === 0) {
                dataQuality.push(tag);
                return {
                    tradePnl: null as number | null,
                    winrate: null as number | null,
                    pnlSd: null as number | null,
                    trades: 0,
                    shortRatio: null as number | null,
                };
            }
            const closed = inWindow.map((t) => num((t as any).closedPnl) ?? 0);
            const fees = inWindow.map((t) => num((t as any).fee) ?? 0);
            const sumClosed = closed.reduce((a, b) => a + b, 0);
            const sumFees = fees.reduce((a, b) => a + b, 0);
            const wins = closed.filter((v) => v > 0).length;
            const shorts = inWindow.filter((t) =>
                String((t as any)?.dir ?? "")
                    .toLowerCase()
                    .includes("short")
            ).length;
            const mean = sumClosed / count;
            const variance =
                closed.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / count;
            return {
                tradePnl: sumClosed - sumFees,
                winrate: wins / count,
                pnlSd: Math.sqrt(variance),
                trades: count,
                shortRatio: shorts / count,
            };
        };

        const w7 = windowStats(7, "no_trades_7d");
        const w30 = windowStats(30, "no_trades_30d");

        // ---- Open positions ----
        const positions = Array.isArray(raw?.assetPositions) ? raw.assetPositions : [];
        if (positions.length === 0) dataQuality.push("no_positions");

        let unrealizedPnl = 0;
        let grossExposure = 0;
        let netExposure = 0;
        let btcExposure = 0;
        let majorsExposure = 0;
        const majors = new Set(["BTC", "ETH", "SOL"]);
        for (const entry of positions) {
            const p = (entry as any)?.position;
            if (!p) continue;
            const value = num(p.positionValue);
            const szi = num(p.szi);
            if (value === null || szi === null) continue;
            const absValue = Math.abs(value);
            const signedValue = szi >= 0 ? absValue : -absValue;
            const coin = String(p.coin ?? "");
            unrealizedPnl += num(p.unrealizedPnl) ?? 0;
            grossExposure += absValue;
            netExposure += signedValue;
            if (coin === "BTC") btcExposure += signedValue;
            if (majors.has(coin)) majorsExposure += signedValue;
        }
        const altsExposure = netExposure - majorsExposure;

        // ---- Direction (replicates getVaultNetDirection) ----
        let direction: "long" | "short" | "neutral";
        if (grossExposure === 0) {
            direction = "neutral";
        } else {
            const ratio = netExposure / grossExposure;
            direction = ratio > 0.2 ? "long" : ratio < -0.2 ? "short" : "neutral";
        }

        // ---- _rt normalization ----
        const rt = (numerator: number | null): number | null =>
            validTvl && numerator !== null ? numerator / tvl : null;

        const dayRt = rt(dayPnl);
        const weekRt = rt(weekPnl);
        const pnl7Rt = rt(w7.tradePnl);
        const pnl30Rt = rt(w30.tradePnl);
        const unrealRt = rt(unrealizedPnl);
        const netRt = rt(netExposure);
        const btcRt = rt(btcExposure);
        const majorsRt = rt(majorsExposure);
        const altsRt = rt(altsExposure);
        const grossLev = rt(grossExposure);

        // ---- mmProxy ----
        const mmProxy: 0 | 1 =
            w30.trades >= 60 &&
            w30.pnlSd !== null &&
            w30.tradePnl !== null &&
            w30.pnlSd <= Math.abs(w30.tradePnl) / 10
                ? 1
                : 0;

        return {
            address,
            name,
            tvl,
            dayPnl,
            weekPnl,
            monthPnl,
            allTimePnl,
            monthMaxDdRt,
            tradePnl7d: w7.tradePnl,
            winrate7d: w7.winrate,
            pnlSd7d: w7.pnlSd,
            trades7d: w7.trades,
            shortRatio7d: w7.shortRatio,
            tradePnl30d: w30.tradePnl,
            winrate30d: w30.winrate,
            pnlSd30d: w30.pnlSd,
            trades30d: w30.trades,
            shortRatio30d: w30.shortRatio,
            unrealizedPnl,
            grossExposure,
            netExposure,
            btcExposure,
            majorsExposure,
            altsExposure,
            dayRt,
            weekRt,
            pnl7Rt,
            pnl30Rt,
            unrealRt,
            netRt,
            btcRt,
            majorsRt,
            altsRt,
            grossLev,
            mmProxy,
            direction,
            dataQuality,
        };
    }

    /** robust z over the values vector: (x - median) / (1.4826 * MAD),
     * MAD=0 -> fall back to population-std z, clip to [-3, 3].
     * nulls excluded from stats; null in -> null out.
     * Fewer than 3 non-null values -> every entry maps to 0 (or null). */
    static robustZ(values: Array<number | null>): Array<number | null> {
        const usable: number[] = [];
        for (const v of values) {
            if (v !== null && Number.isFinite(v)) usable.push(v);
        }

        // Fewer than 3 usable values: non-null -> 0, null -> null.
        if (usable.length < 3) {
            return values.map((v) => (v === null || !Number.isFinite(v as number) ? null : 0));
        }

        const sorted = [...usable].sort((a, b) => a - b);
        const med = median(sorted);
        const absDev = usable.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
        const mad = median(absDev);

        if (mad > 0) {
            const denom = 1.4826 * mad;
            return values.map((v) =>
                v === null || !Number.isFinite(v as number)
                    ? null
                    : clamp((v - med) / denom, -3, 3)
            );
        }

        // MAD === 0 -> population-std fallback.
        const mean = usable.reduce((a, b) => a + b, 0) / usable.length;
        const variance =
            usable.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / usable.length;
        const std = Math.sqrt(variance);
        if (std === 0) {
            return values.map((v) =>
                v === null || !Number.isFinite(v as number) ? null : 0
            );
        }
        return values.map((v) =>
            v === null || !Number.isFinite(v as number)
                ? null
                : clamp((v - mean) / std, -3, 3)
        );
    }

    /** Alignment classification + penalty (shared by both stages). */
    private static alignment(
        regime: RegimeFlags["regime"],
        direction: "long" | "short" | "neutral"
    ): { alignmentPenalty: number; aligned: VaultQuantScore["aligned"] } {
        const conflicted =
            (regime === "risk-off" && direction === "long") ||
            (regime === "risk-on" && direction === "short");
        if (conflicted) {
            return { alignmentPenalty: -0.3, aligned: "conflicted" };
        }
        const isAligned =
            (regime === "risk-on" && direction === "long") ||
            (regime === "risk-off" && direction === "short");
        if (isAligned) {
            return { alignmentPenalty: 0, aligned: "aligned" };
        }
        return { alignmentPenalty: 0, aligned: "neutral" };
    }

    private static buildScore(
        f: VaultQuantFeatures,
        baseScoreZ: number,
        overlayZ: number,
        alignmentPenalty: number,
        aligned: VaultQuantScore["aligned"]
    ): VaultQuantScore {
        const rawScore = baseScoreZ + overlayZ + alignmentPenalty;
        const score = clamp(round1(50 + 15 * rawScore), 0, 100);
        return {
            address: f.address,
            name: f.name,
            baseScoreZ,
            overlayZ,
            alignmentPenalty,
            rawScore,
            score,
            aligned,
        };
    }
}
