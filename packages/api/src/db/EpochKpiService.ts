import { withDb } from "./pool";
import {
    applyEvent,
    createEmptyState,
    totalOpenBasis,
    type AccountState,
} from "./PositionAccountService";

/**
 * Fresh-epoch strategy KPIs.
 *
 * On 2026-07-02 the strategy shipped a bundle of structural changes (risk-only
 * rounds, profit-gated trims, loss re-entry cooldown, per-position ROE fed to
 * Claude, chop brake). The go/no-go decision after 2-3 months must be made on
 * clean post-change data, so every statistic here is computed strictly from
 * ledger activity at or after METRICS_EPOCH_START — a fresh scoreboard,
 * independent of the lifetime metrics on /api/metrics.
 *
 * RE-BASED TO 2026-07-09 (STRATEGY-FORENSICS-2026-07 §2): from Jul 2–8 the
 * book was mostly traded by zombie pre-overhaul revisions (the 2026-07-09
 * incident) and then by credit-exhaustion fallback rounds — the overhauled
 * strategy's first clean rounds are 38/39 on Jul 9+. Judging the overhaul on
 * Jul 2–8 data would judge the OLD code.
 *
 * The per-close realized PnL uses the same FIFO replay as position_account
 * (PositionAccountService.applyEvent), replaying the FULL ledger from
 * inception so cost basis carried into the epoch is correct, then keeping
 * only closes inside the epoch window.
 *
 * Closes are additionally split by ORIGINATION: a close whose oldest consumed
 * FIFO lot was deposited at/after the epoch start is `originated` (the new
 * strategy opened AND closed it); otherwise it is `inherited` (cleanup of
 * pre-epoch/zombie inventory — e.g. FKA −$16.42 on Jul 9 was opened pre-epoch
 * and closed by clean round 38). The go/no-go must be judged on
 * `closesOriginated`.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FLAT_THRESHOLD_USD = 0.05;
// A "churn close" realizes a small loss (0–5% of the basis it consumed):
// the signature of rotating a position that hadn't done anything yet.
// 51 of the 85 lifetime losing closes were in this band.
const CHURN_LOSS_FRACTION = 0.05;

export type RawLedgerRow = {
    time: number;
    vaultAddress: string;
    type: "vaultDeposit" | "vaultWithdraw";
    usdc: number;
    netWithdrawnUsd: number | null;
    basisUsdHl: number | null;
};

export type EpochClose = {
    time: number;
    vaultAddress: string;
    realizedPnlUsd: number;
    basisConsumedUsd: number;
    /** True when the oldest FIFO lot this close consumed was deposited at or
     * after the epoch start — i.e. the position was opened by the current
     * strategy, not inherited from before the epoch. */
    originatedInEpoch: boolean;
};

export type EpochCloseStats = {
    count: number;
    wins: number;
    losses: number;
    flats: number;
    winRatePct: number | null;
    realizedPnlUsd: number;
    grossWinsUsd: number;
    grossLossesUsd: number;
    avgWinUsd: number | null;
    avgLossUsd: number | null;
    /** avgWin / avgLoss — the skew ratio. The 5-month lifetime value was 0.76
     * (avg win $8.38 vs avg loss $11.07); the profit-gated trims exist to push
     * this above 1. */
    winLossRatio: number | null;
    profitFactor: number | null;
    expectancyUsdPerClose: number | null;
    churn: { count: number; lossUsd: number };
};

export type EpochKpis = {
    epochStart: string;
    days: number;
    /** All closes inside the epoch window (backward-compatible view). */
    closes: EpochCloseStats;
    /** Closes of positions the current strategy itself opened (oldest
     * consumed lot deposited in-epoch). THE go/no-go scoreboard. */
    closesOriginated: EpochCloseStats;
    /** Cleanup of inventory opened before the epoch (or by the zombie
     * revisions) — informative, but not attributable to the new strategy. */
    closesInherited: EpochCloseStats;
    deposits: { count: number; totalUsd: number };
    openBasisUsd: number;
    rounds: {
        completed: number;
        riskOnly: number;
        aborted: number;
        failed: number;
    };
    eventCounts: Record<string, number>;
    calculatedAt: string;
};

/**
 * Replay the full ledger with FIFO basis, returning the closes and deposits
 * that fall inside the epoch window plus the current open basis. Pure —
 * unit-testable without a database.
 */
export function computeEpochLedgerStats(
    rows: RawLedgerRow[],
    epochStartMs: number
): {
    closes: EpochClose[];
    deposits: { count: number; totalUsd: number };
    openBasisUsd: number;
} {
    const sorted = [...rows].sort((a, b) => a.time - b.time);
    const stateByVault = new Map<string, AccountState>();
    const closes: EpochClose[] = [];
    let depositCount = 0;
    let depositTotal = 0;

    for (const row of sorted) {
        if (!Number.isFinite(row.time) || !Number.isFinite(row.usdc)) continue;
        const vault = row.vaultAddress.toLowerCase();
        const state = stateByVault.get(vault) ?? createEmptyState(vault);
        // FIFO consumes lots front-to-back, so the first lot with remaining
        // basis BEFORE the withdrawal is the oldest lot this close consumes —
        // its deposit time decides originated-vs-inherited attribution.
        const oldestOpenLot = state.lots.find(
            (l) => l.remainingBasisUsd > 1e-9
        );
        const result = applyEvent(state, {
            time: new Date(row.time),
            type: row.type,
            usdc: row.usdc,
            netWithdrawnUsd: row.netWithdrawnUsd,
            basisUsdHl: row.basisUsdHl,
        });
        stateByVault.set(vault, result.state);

        if (row.time < epochStartMs) continue;
        if (row.type === "vaultDeposit") {
            depositCount += 1;
            depositTotal += row.usdc;
        } else {
            closes.push({
                time: row.time,
                vaultAddress: vault,
                realizedPnlUsd: result.realizedPnl,
                basisConsumedUsd: result.basisConsumed,
                originatedInEpoch:
                    oldestOpenLot != null &&
                    oldestOpenLot.depositedAt.getTime() >= epochStartMs,
            });
        }
    }

    let openBasisUsd = 0;
    for (const state of stateByVault.values()) {
        openBasisUsd += totalOpenBasis(state);
    }

    return {
        closes,
        deposits: { count: depositCount, totalUsd: round2(depositTotal) },
        openBasisUsd: round2(openBasisUsd),
    };
}

/** Aggregate per-close realized PnL into the KPI block. Pure. */
export function computeCloseStats(closes: EpochClose[]): EpochCloseStats {
    let wins = 0;
    let losses = 0;
    let flats = 0;
    let grossWins = 0;
    let grossLosses = 0;
    let churnCount = 0;
    let churnLoss = 0;
    let realized = 0;

    for (const close of closes) {
        const pnl = close.realizedPnlUsd;
        realized += pnl;
        if (pnl > FLAT_THRESHOLD_USD) {
            wins += 1;
            grossWins += pnl;
        } else if (pnl < -FLAT_THRESHOLD_USD) {
            losses += 1;
            grossLosses += -pnl;
            if (
                close.basisConsumedUsd > 0 &&
                -pnl / close.basisConsumedUsd <= CHURN_LOSS_FRACTION
            ) {
                churnCount += 1;
                churnLoss += -pnl;
            }
        } else {
            flats += 1;
        }
    }

    const count = closes.length;
    const decisive = wins + losses;
    return {
        count,
        wins,
        losses,
        flats,
        winRatePct: decisive > 0 ? round2((wins / decisive) * 100) : null,
        realizedPnlUsd: round2(realized),
        grossWinsUsd: round2(grossWins),
        grossLossesUsd: round2(grossLosses),
        avgWinUsd: wins > 0 ? round2(grossWins / wins) : null,
        avgLossUsd: losses > 0 ? round2(grossLosses / losses) : null,
        winLossRatio:
            wins > 0 && losses > 0
                ? round2(grossWins / wins / (grossLosses / losses))
                : null,
        profitFactor:
            grossLosses > 0 ? round2(grossWins / grossLosses) : null,
        expectancyUsdPerClose: count > 0 ? round2(realized / count) : null,
        churn: { count: churnCount, lossUsd: round2(churnLoss) },
    };
}

export class EpochKpiService {
    static epochStart(): Date {
        // 2026-07-09: first clean post-overhaul rounds (38/39), after the
        // zombie revisions were killed and Anthropic credits restored.
        const raw = process.env.METRICS_EPOCH_START ?? "2026-07-09T00:00:00Z";
        const parsed = new Date(raw);
        return Number.isFinite(parsed.getTime())
            ? parsed
            : new Date("2026-07-09T00:00:00Z");
    }

    /** Returns null when the trace database is unavailable. */
    static async compute(): Promise<EpochKpis | null> {
        const epochStart = this.epochStart();
        const epochStartMs = epochStart.getTime();

        return await withDb("epochKpis", async (client) => {
            const ledger = await client.query<{
                time: Date;
                vault_address: string;
                type: "vaultDeposit" | "vaultWithdraw";
                usdc: string;
                net_withdrawn_usd: string | null;
                basis_usd_hl: string | null;
            }>(
                `SELECT time, LOWER(vault_address) AS vault_address, type,
                        usdc, net_withdrawn_usd, basis_usd_hl
                 FROM position_ledger
                 ORDER BY time ASC, id ASC`
            );
            const rows: RawLedgerRow[] = ledger.rows.map((r) => ({
                time: r.time.getTime(),
                vaultAddress: r.vault_address,
                type: r.type,
                usdc: Number(r.usdc),
                netWithdrawnUsd:
                    r.net_withdrawn_usd != null
                        ? Number(r.net_withdrawn_usd)
                        : null,
                basisUsdHl:
                    r.basis_usd_hl != null ? Number(r.basis_usd_hl) : null,
            }));

            const ledgerStats = computeEpochLedgerStats(rows, epochStartMs);

            const roundsResult = await client.query<{
                status: string;
                risk_only: string;
                count: string;
            }>(
                `SELECT status,
                        COUNT(*) FILTER (WHERE summary_json->>'mode' = 'risk-only')::text AS risk_only,
                        COUNT(*)::text AS count
                 FROM rebalance_round
                 WHERE started_at >= $1
                 GROUP BY status`,
                [epochStart]
            );
            const rounds = {
                completed: 0,
                riskOnly: 0,
                aborted: 0,
                failed: 0,
            };
            for (const row of roundsResult.rows) {
                const n = Number(row.count);
                if (row.status === "completed") {
                    rounds.completed = n;
                    rounds.riskOnly = Number(row.risk_only);
                } else if (row.status === "aborted") rounds.aborted = n;
                else if (row.status === "failed") rounds.failed = n;
            }

            const eventsResult = await client.query<{
                action: string;
                count: string;
            }>(
                `SELECT action, COUNT(*)::text AS count
                 FROM position_event
                 WHERE occurred_at >= $1 AND succeeded = true
                 GROUP BY action`,
                [epochStart]
            );
            const eventCounts: Record<string, number> = {};
            for (const row of eventsResult.rows) {
                eventCounts[row.action] = Number(row.count);
            }

            const now = Date.now();
            return {
                epochStart: epochStart.toISOString(),
                days: round2(Math.max(0, now - epochStartMs) / MS_PER_DAY),
                closes: computeCloseStats(ledgerStats.closes),
                closesOriginated: computeCloseStats(
                    ledgerStats.closes.filter((c) => c.originatedInEpoch)
                ),
                closesInherited: computeCloseStats(
                    ledgerStats.closes.filter((c) => !c.originatedInEpoch)
                ),
                deposits: ledgerStats.deposits,
                openBasisUsd: ledgerStats.openBasisUsd,
                rounds,
                eventCounts,
                calculatedAt: new Date(now).toISOString(),
            };
        });
    }
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}
