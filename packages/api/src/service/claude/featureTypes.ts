// FROZEN CONTRACT between VaultFeatureService (WP-A) and ClaudeService (WP-C).
// See dev-instructions/00-OVERVIEW.md §4. Do not modify without architect sign-off.

import type { VaultCandidate } from "../vaults/types";

export type RegimeFlags = {
    /** btc_7d_change < 0 (false when input null) */
    bearFlag: boolean;
    /** funding_btc > 0 (false when input null) */
    fundingPos: boolean;
    /** dominance > 55 (false when input null) */
    domHigh: boolean;
    /** fearGreed <= 30 (false when input null) */
    fearHigh: boolean;
    /** btc_7d_change > 0 AND fearGreed > 50 (false when either null) */
    riskOn: boolean;
    /** eth_7d_change > btc_7d_change AND dominance < 50 (false when any null) */
    altSeason: boolean;
    /** long_short_ratio > 1.5 (false when input null). Renamed from the old
     * misleading "highOI" — it measures positioning skew, not open interest. */
    crowdedLongs: boolean;
    /** riskOn -> "risk-on"; else bearFlag -> "risk-off"; else "neutral" */
    regime: "risk-on" | "risk-off" | "neutral";
};

export type VaultQuantFeatures = {
    /** lowercase 0x address */
    address: string;
    name: string;
    tvl: number;

    // PnL levels in USD, deltas of the (cumulative) HL pnl series
    dayPnl: number | null;
    weekPnl: number | null;
    monthPnl: number | null;
    allTimePnl: number | null;
    /** max peak-to-trough decline within the month series, / tvl, >= 0 */
    monthMaxDdRt: number | null;

    // Trade-window stats (window = trade.time within [nowMs - Nd, nowMs])
    tradePnl7d: number | null;
    winrate7d: number | null;
    pnlSd7d: number | null;
    trades7d: number;
    shortRatio7d: number | null;
    tradePnl30d: number | null;
    winrate30d: number | null;
    pnlSd30d: number | null;
    trades30d: number;
    shortRatio30d: number | null;

    // Open-position aggregates (USD)
    unrealizedPnl: number;
    grossExposure: number;
    netExposure: number;
    btcExposure: number;
    majorsExposure: number;
    altsExposure: number;

    // TVL-normalized (_rt); null when tvl <= 0 or numerator null
    dayRt: number | null;
    weekRt: number | null;
    pnl7Rt: number | null;
    pnl30Rt: number | null;
    unrealRt: number | null;
    netRt: number | null;
    btcRt: number | null;
    majorsRt: number | null;
    altsRt: number | null;
    grossLev: number | null;

    /** 1 when trades30d >= 60 AND pnlSd30d <= |tradePnl30d| / 10, else 0 */
    mmProxy: 0 | 1;
    /** net/gross > 0.2 -> long, < -0.2 -> short, else neutral (matches
     * getVaultNetDirection in RebalanceOrchestrator.ts) */
    direction: "long" | "short" | "neutral";
    /** e.g. ["no_tvl", "no_trades_7d", "no_trades_30d", "no_month_series",
     * "no_day_series", "no_week_series", "no_positions"] */
    dataQuality: string[];
};

export type VaultQuantScore = {
    address: string;
    name: string;
    /** weighted sum of clipped robust-z features (stage-specific weights) */
    baseScoreZ: number;
    /** regime overlay term */
    overlayZ: number;
    /** 0 or -0.3 (direction conflicts with regime) */
    alignmentPenalty: number;
    /** baseScoreZ + overlayZ + alignmentPenalty */
    rawScore: number;
    /** clamp(round1(50 + 15 * rawScore), 0, 100); round1 = 1 decimal */
    score: number;
    aligned: "aligned" | "conflicted" | "neutral";
};

export type VaultUniverseScores = {
    regime: RegimeFlags;
    features: VaultQuantFeatures[];
    /** stage-1 profile: multi-day-hold weights (30d consistency emphasized) */
    scoring: VaultQuantScore[];
    /** stage-2 profile: 48h-recency weights */
    ranking: VaultQuantScore[];
};

export type VaultTradeRow = {
    time: number;
    dir: string;
    closedPnl: number;
    fee: number;
};

export type PnlPoint = [number, number];
export type PnlSeries = [string, PnlPoint[]];

export type VaultRawData = {
    candidate: VaultCandidate;
    trades: VaultTradeRow[];
    /** entries shaped { position: { coin, szi, positionValue, unrealizedPnl } } */
    assetPositions: any[];
    /** period in {"day","week","month","allTime"} (perp* variants may appear) */
    pnls: PnlSeries[];
};
