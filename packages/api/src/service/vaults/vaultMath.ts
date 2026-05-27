// Pure helpers extracted from VaultService so unit tests don't drag in the
// Hyperliquid SDK transitively via the connector. Anything in here must be
// pure — no DB, no network, no module-level state, no imports that pull in
// runtime side effects.

import type {
    TimeSeriesPoint,
    UserPortfolioSummary,
    VaultCandidate,
    VaultRecommendation,
} from "./types";
import type { UserLedgerUpdate } from "../trade/HyperliquidConnector";

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type LedgerSummary = {
    deposits: number;
    withdrawals: number;
    currentDeposits: number;
};

export function pickFinite(value: number | null | undefined): number | null {
    // `Number(null)` is `0` (finite), so a naive Number.isFinite check would
    // treat an explicit-null window as a valid `0` value — that breaks
    // extractAccountEquity's fall-through chain. Reject null/undefined first.
    if (value === null || value === undefined) return null;
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function safeRatio(value: number | null, denom: number): number {
    if (value === null) return 0;
    if (!Number.isFinite(value) || !Number.isFinite(denom) || denom === 0) return 0;
    return value / denom;
}

export function round(value: number, digits: number): number {
    const factor = Math.pow(10, digits);
    return Math.round(value * factor) / factor;
}

export function ageInDays(createTimeMillis: number): number {
    if (!Number.isFinite(Number(createTimeMillis))) return 0;
    const delta = Date.now() - Number(createTimeMillis);
    return Math.max(0, delta / MS_PER_DAY);
}

export function extractAccountEquity(
    portfolio: UserPortfolioSummary | null
): number | null {
    const equity = portfolio?.metrics?.accountEquity;
    if (!equity) return null;
    return (
        pickFinite(equity.allTime) ??
        pickFinite(equity["30d"]) ??
        pickFinite(equity["7d"]) ??
        pickFinite(equity["24h"])
    );
}

export function calcUnrealizedPnlFromLedger(
    amountUsd: number | null,
    ledger?: LedgerSummary
): number | null {
    if (!ledger) return null;
    const netDeposits = ledger.currentDeposits;
    if (!Number.isFinite(netDeposits) || netDeposits <= 0) return null;
    if (!Number.isFinite(amountUsd)) return null;
    return (amountUsd as number) - netDeposits;
}

export function deriveEntryUsd(
    amountUsd: number | null,
    pnlUsd: number | null,
    ledger?: LedgerSummary
): number | null {
    if (ledger && ledger.currentDeposits > 0) {
        return ledger.currentDeposits;
    }
    if (amountUsd !== null && pnlUsd !== null) {
        const entryUsd = amountUsd - pnlUsd;
        return Number.isFinite(entryUsd) ? entryUsd : null;
    }
    return amountUsd;
}

export function buildLedgerByVault(
    updates: {
        vault: string;
        type: string;
        usdc: number;
        time?: number;
        basisUsd?: number;
    }[],
    minPositionUsd: number
): Map<string, LedgerSummary> {
    const grouped = new Map<
        string,
        {
            vault: string;
            type: string;
            usdc: number;
            time: number;
            basisUsd?: number;
        }[]
    >();
    for (const update of updates) {
        const vault = update.vault?.toLowerCase();
        if (!vault) continue;
        const time = Number(update.time);
        if (!Number.isFinite(time)) continue;
        const bucket = grouped.get(vault) ?? [];
        bucket.push({
            vault,
            type: update.type,
            usdc: update.usdc,
            time,
            basisUsd: update.basisUsd,
        });
        grouped.set(vault, bucket);
    }
    const map = new Map<string, LedgerSummary>();
    for (const [vault, entries] of grouped.entries()) {
        entries.sort((a, b) => a.time - b.time);
        let deposits = 0;
        let withdrawals = 0;
        let current = 0;
        for (const entry of entries) {
            if (entry.type === "vaultDeposit") {
                deposits += entry.usdc;
                current += entry.usdc;
            } else if (entry.type === "vaultWithdraw") {
                withdrawals += entry.usdc;
                // basisUsd is the cost basis of the shares withdrawn; netWithdrawnUsd
                // (usdc) is the cash received, which differs by the realized PnL on
                // those shares. Reducing basis by usdc instead of basisUsd leaves a
                // residual equal to the realized loss/gain, which then contaminates
                // PnL on any later redeposit.
                const basisOut = Number.isFinite(entry.basisUsd)
                    ? (entry.basisUsd as number)
                    : entry.usdc;
                current -= basisOut;
            }
            if (current < 0) {
                current = 0;
            }
        }
        map.set(vault, { deposits, withdrawals, currentDeposits: current });
    }
    return map;
}

export function pickPnl(
    perf: { pnl?: number | null; allTimePnl?: number | null } | null,
    history: { pnl?: { points: { timestamp: number; value: number }[] } | null } | undefined,
    amountUsd: number | null,
    ledger?: LedgerSummary
): number | null {
    const ledgerPnl = calcUnrealizedPnlFromLedger(amountUsd, ledger);
    if (Number.isFinite(ledgerPnl)) return ledgerPnl as number;
    if (perf) {
        if (Number.isFinite(Number(perf.pnl))) return Number(perf.pnl);
        if (Number.isFinite(Number(perf.allTimePnl))) return Number(perf.allTimePnl);
    }
    const points = history?.pnl?.points;
    if (Array.isArray(points) && points.length) {
        const last = points[points.length - 1]?.value;
        if (Number.isFinite(Number(last))) return Number(last);
    }
    return null;
}

export function maxDrawdownFromPnls(pnls: any, tvl: number): number | null {
    if (!Array.isArray(pnls) || !pnls.length || tvl <= 0) return null;
    const allTimeSeries = pnls[0];
    const points = Array.isArray(allTimeSeries?.[1]) ? allTimeSeries[1] : allTimeSeries;
    if (!Array.isArray(points) || points.length < 2) return null;
    let peak = -Infinity;
    let maxDdPct = 0;
    for (const point of points) {
        const pnl = Number(Array.isArray(point) ? point[1] ?? point[0] : point);
        if (!Number.isFinite(pnl)) continue;
        const value = tvl + pnl;
        if (value > peak) peak = value;
        if (peak > 0) {
            const dd = ((peak - value) / peak) * 100;
            if (dd > maxDdPct) maxDdPct = dd;
        }
    }
    return maxDdPct > 0 ? maxDdPct : null;
}

export function normalizeSeries(
    points?: TimeSeriesPoint[] | null
): TimeSeriesPoint[] {
    if (!Array.isArray(points)) return [];
    return points
        .map((point) => ({
            timestamp: Number(point.timestamp),
            value: Number(point.value),
        }))
        .filter(
            (point) =>
                Number.isFinite(point.timestamp) && Number.isFinite(point.value)
        )
        .sort((a, b) => a.timestamp - b.timestamp);
}

export function latestSeriesValue(points: TimeSeriesPoint[]): number | null {
    if (!points.length) return null;
    const last = points[points.length - 1];
    return Number.isFinite(last?.value) ? last.value : null;
}

export function findValueAtOrBefore(
    points: TimeSeriesPoint[],
    target: number
): number | null {
    if (!Number.isFinite(target) || !points.length) return null;
    let value: number | null = null;
    for (const point of points) {
        if (point.timestamp <= target) {
            value = point.value;
        } else {
            break;
        }
    }
    return Number.isFinite(value) ? (value as number) : null;
}

// Returns a NON-NEGATIVE fraction in [0, 1]. Callers that want the
// project-wide *signed* drawdown percentage (negative, matching
// readMaxDrawdownFromSeries and `formatPercentSigned` on the frontend) must
// transform with `toSignedDrawdownPct` below.
export function calcVaultMaxDrawdownPct(points: TimeSeriesPoint[]): number {
    if (points.length < 2) return 0;
    let peak = points[0].value;
    let maxDd = 0;
    for (const point of points) {
        if (point.value > peak) peak = point.value;
        if (peak <= 0) continue;
        const dd = (peak - point.value) / peak;
        if (dd > maxDd) maxDd = dd;
    }
    return maxDd;
}

/**
 * Convert a positive drawdown fraction (0..1) into the project-wide signed
 * percentage convention: NEGATIVE for a loss (e.g. 0.195 -> -19.5).
 *
 * Don't drop the negation thinking "drawdown should be positive". The whole
 * pipeline -- DB helper `readMaxDrawdownFromSeries`, the
 * `PlatformMetricsResponse.maxDrawdownPct` field, and the frontend's
 * `formatPercentSigned` -- assumes signed (negative) drawdown values.
 */
export function toSignedDrawdownPct(positiveFraction: number): number {
    return -(positiveFraction * 100);
}

export function calcPnlPct(
    updates: UserLedgerUpdate[],
    minUsd: number,
    days: number = 30,
    openPositions?: { pnlUsd: number | null; amountUsd: number | null }[]
): number | null {
    const cutoff = Date.now() - days * MS_PER_DAY;
    const closures = updates.filter((entry) => {
        if (entry.type !== "vaultWithdraw") return false;
        if (!Number.isFinite(entry.time) || entry.time < cutoff) return false;
        if (Math.abs(entry.usdc) < minUsd) return false;
        return (
            Number.isFinite(entry.netWithdrawnUsd) &&
            Number.isFinite(entry.basisUsd) &&
            (entry.basisUsd as number) > 0
        );
    });
    let totalPnl = 0;
    let totalBasis = 0;
    for (const entry of closures) {
        const basis = entry.basisUsd as number;
        const pnl = (entry.netWithdrawnUsd as number) - basis;
        totalPnl += pnl;
        totalBasis += basis;
    }
    if (openPositions) {
        for (const pos of openPositions) {
            if (
                pos.pnlUsd !== null &&
                pos.amountUsd !== null &&
                Number.isFinite(pos.pnlUsd) &&
                Number.isFinite(pos.amountUsd)
            ) {
                const basis = pos.amountUsd - pos.pnlUsd;
                if (basis > 0) {
                    totalPnl += pos.pnlUsd;
                    totalBasis += basis;
                }
            }
        }
    }
    if (totalBasis <= 0) return null;
    return (totalPnl / totalBasis) * 100;
}

export function calcWinRatePct(
    updates: UserLedgerUpdate[],
    sinceMs: number,
    minUsd: number
): number | null {
    const realized = updates.filter((entry) => {
        if (entry.type !== "vaultWithdraw") return false;
        if (!Number.isFinite(entry.time) || entry.time < sinceMs) return false;
        if (Math.abs(entry.usdc) < minUsd) return false;
        return (
            Number.isFinite(entry.netWithdrawnUsd) &&
            Number.isFinite(entry.basisUsd)
        );
    });
    if (!realized.length) return null;
    const wins = realized.filter(
        (entry) =>
            Number(entry.netWithdrawnUsd) - Number(entry.basisUsd) > 0
    ).length;
    return (wins / realized.length) * 100;
}

export function rebasePortfolioPnl(
    portfolio: UserPortfolioSummary | null,
    sinceMs: number
): UserPortfolioSummary | null {
    if (!portfolio?.history?.pnl?.points) return portfolio;
    const points = normalizeSeries(portfolio.history.pnl.points);
    if (!points.length) return portfolio;
    const baseline =
        findValueAtOrBefore(points, sinceMs) ?? points[0]?.value ?? 0;
    const rebased = points
        .filter((point) => point.timestamp >= sinceMs)
        .map((point) => ({
            timestamp: point.timestamp,
            value: round(point.value - baseline, 8),
        }));
    return {
        ...portfolio,
        history: {
            ...portfolio.history,
            pnl: { points: rebased },
        },
    };
}

export function applyAllocation(
    items: VaultRecommendation[],
    totalPct: number
): VaultRecommendation[] {
    if (!items.length) return items;
    const per = totalPct / items.length;
    const rounded = items.map((item) => ({
        ...item,
        allocationPct: round(per, 2),
    }));
    const sum = rounded.reduce((acc, item) => acc + item.allocationPct, 0);
    const diff = round(totalPct - sum, 2);
    if (rounded.length && Math.abs(diff) > 0) {
        rounded[0].allocationPct = round(rounded[0].allocationPct + diff, 2);
    }
    return rounded;
}

// Pure inception PnL% calc shared with VaultService.pnlPctFromBooks (which adds
// async windowed-PnL queries on top). Bug-5 regression: the denominator is
// wallet-growth (walletValue - totalPnlNow), NOT raw vaultEquity — using
// vaultEquity as denominator silently inflates the displayed return.
export function calcInceptionPnlPct(
    realizedPnlTotal: number,
    basisOpenTotal: number,
    vaultEquityUsd: number | null,
    walletValueUsd: number | null
): { totalPnlNow: number; impliedSeed: number; inceptionPct: number } | null {
    if (!Number.isFinite(vaultEquityUsd) || (vaultEquityUsd as number) <= 0) return null;
    if (basisOpenTotal <= 0) return null;
    const totalPnlNow =
        realizedPnlTotal + ((vaultEquityUsd as number) - basisOpenTotal);
    const impliedSeed =
        Number.isFinite(walletValueUsd) &&
        (walletValueUsd as number) - totalPnlNow > 0
            ? (walletValueUsd as number) - totalPnlNow
            : basisOpenTotal;
    const inceptionPct = (totalPnlNow / impliedSeed) * 100;
    return { totalPnlNow, impliedSeed, inceptionPct };
}

export function scoreCandidate(candidate: VaultCandidate): number {
    const weeklyPct = safeRatio(candidate.weeklyPnl, candidate.tvl);
    const monthlyPct = safeRatio(candidate.monthlyPnl, candidate.tvl);
    const allTimePct = safeRatio(candidate.allTimePnl, candidate.tvl);
    const tvlScore = Math.log10(candidate.tvl + 1);
    const followersScore =
        candidate.followers && candidate.followers > 0
            ? Math.log10(candidate.followers + 1)
            : 0;
    const tradesScore =
        candidate.tradesLast7d && candidate.tradesLast7d > 0
            ? Math.log10(candidate.tradesLast7d + 1)
            : 0;
    const ageScore = Math.min(candidate.ageDays / 30, 12);
    return (
        weeklyPct * 400 +
        monthlyPct * 200 +
        allTimePct * 100 +
        tvlScore * 10 +
        followersScore * 2 +
        tradesScore +
        ageScore
    );
}
