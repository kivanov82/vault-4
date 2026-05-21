import { PoolClient } from "pg";
import { withDb } from "./pool";
import { logger } from "../service/utils/logger";
import { HyperliquidConnector, UserLedgerUpdate } from "../service/trade/HyperliquidConnector";
import type { MarketOverlay } from "../service/claude/MarketDataService";
import {
    applyEvent,
    LedgerEvent,
    recomputeAccountFor,
    recomputeAllAccounts,
    replayLedger,
    totalOpenBasis,
} from "./PositionAccountService";
import { PositionEventInput } from "./types";

export type VaultSnapshotInput = {
    vaultAddress: string;
    vaultName?: string | null;
    tvlUsd?: number | null;
    ageDays?: number | null;
    followers?: number | null;
    allowDeposits?: boolean | null;
    isClosed?: boolean | null;
    tradesLast7d?: number | null;
    currentPositionsCount?: number | null;
    openPositions?: any;
    pnl24h?: number | null;
    pnl7d?: number | null;
    pnl30d?: number | null;
    pnlAlltime?: number | null;
    maxDrawdownPct?: number | null;
    marginUtilPct?: number | null;
    netDirection?: "long" | "short" | "neutral" | null;
    assumedBias?: "long" | "short" | "neutral" | null;
};

export class TraceService {
    static async startRound(): Promise<number | null> {
        const result = await withDb<number>(
            "startRound",
            async (client) => {
                const r = await client.query<{ id: number }>(
                    `INSERT INTO rebalance_round (status) VALUES ('running') RETURNING id`
                );
                return r.rows[0]?.id ?? null;
            },
            null as any
        );
        return result ?? null;
    }

    static async endRound(
        roundId: number | null,
        status: "completed" | "aborted" | "failed",
        summary: any,
        errorText?: string
    ): Promise<void> {
        if (!roundId) return;
        await withDb("endRound", async (client) => {
            await client.query(
                `UPDATE rebalance_round
                 SET completed_at = now(), status = $1, summary_json = $2, error_text = $3
                 WHERE id = $4`,
                [status, summary ?? null, errorText ?? null, roundId]
            );
        });
    }

    static async recordMarketSnapshot(
        roundId: number | null,
        overlay: MarketOverlay
    ): Promise<void> {
        if (!roundId) return;
        await withDb("recordMarketSnapshot", async (client) => {
            await client.query(
                `INSERT INTO market_snapshot (
                    round_id, preferred_direction,
                    btc_24h_pct, btc_7d_pct, eth_24h_pct, eth_7d_pct,
                    funding_btc, funding_eth, oi_btc, oi_eth,
                    long_short_ratio, fear_greed, btc_dominance, trend, raw_json
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
                [
                    roundId,
                    overlay.preferred_direction,
                    overlay.btc_24h_change,
                    overlay.btc_7d_change,
                    overlay.eth_24h_change,
                    overlay.eth_7d_change,
                    overlay.funding_btc,
                    overlay.funding_eth,
                    overlay.btc_oi_change_24h,
                    overlay.eth_oi_change_24h,
                    overlay.long_short_ratio,
                    overlay.fearGreed,
                    overlay.dominance,
                    overlay.trend,
                    overlay,
                ]
            );
        });
    }

    static async recordClaudeDecision(
        roundId: number | null,
        stage: 1 | 2,
        payload: {
            model?: string;
            regimeLabel?: string;
            regimeNotes?: string;
            top10?: any;
            allocations?: any;
            raw?: any;
        }
    ): Promise<void> {
        if (!roundId) return;
        await withDb("recordClaudeDecision", async (client) => {
            await client.query(
                `INSERT INTO claude_decision (
                    round_id, stage, model, regime_label, regime_notes,
                    top10_json, allocations_json, raw_response_json
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    roundId,
                    stage,
                    payload.model ?? null,
                    payload.regimeLabel ?? null,
                    payload.regimeNotes ?? null,
                    payload.top10 ?? null,
                    payload.allocations ?? null,
                    payload.raw ?? null,
                ]
            );
        });
    }

    static async recordVaultSnapshot(
        roundId: number | null,
        snapshot: VaultSnapshotInput
    ): Promise<number | null> {
        if (!roundId) return null;
        const isAligned =
            snapshot.assumedBias === "neutral" ||
            (snapshot.netDirection != null &&
                snapshot.assumedBias != null &&
                snapshot.netDirection === snapshot.assumedBias);
        const result = await withDb<number>(
            "recordVaultSnapshot",
            async (client) => {
                const r = await client.query<{ id: number }>(
                    `INSERT INTO vault_snapshot (
                        round_id, vault_address, vault_name,
                        tvl_usd, age_days, followers, allow_deposits, is_closed,
                        trades_last_7d, current_positions_count, open_positions_json,
                        pnl_24h, pnl_7d, pnl_30d, pnl_alltime,
                        max_drawdown_pct, margin_util_pct,
                        net_direction, assumed_bias, is_aligned
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                              $12, $13, $14, $15, $16, $17, $18, $19, $20)
                    RETURNING id`,
                    [
                        roundId,
                        snapshot.vaultAddress.toLowerCase(),
                        snapshot.vaultName ?? null,
                        snapshot.tvlUsd ?? null,
                        snapshot.ageDays ?? null,
                        snapshot.followers ?? null,
                        snapshot.allowDeposits ?? null,
                        snapshot.isClosed ?? null,
                        snapshot.tradesLast7d ?? null,
                        snapshot.currentPositionsCount ?? null,
                        snapshot.openPositions ?? null,
                        snapshot.pnl24h ?? null,
                        snapshot.pnl7d ?? null,
                        snapshot.pnl30d ?? null,
                        snapshot.pnlAlltime ?? null,
                        snapshot.maxDrawdownPct ?? null,
                        snapshot.marginUtilPct ?? null,
                        snapshot.netDirection ?? null,
                        snapshot.assumedBias ?? null,
                        snapshot.netDirection != null || snapshot.assumedBias != null
                            ? isAligned
                            : null,
                    ]
                );
                return r.rows[0]?.id ?? null;
            },
            null as any
        );
        return result ?? null;
    }

    static async recordPositionEvent(input: PositionEventInput): Promise<void> {
        await withDb("recordPositionEvent", async (client) => {
            const events = await loadVaultLedgerEvents(client, input.vaultAddress);
            const stateBefore = replayLedger(input.vaultAddress, events);
            const basisBefore = totalOpenBasis(stateBefore);

            const isExecute =
                input.action === "deposit" ||
                input.action === "trim" ||
                input.action.startsWith("exit_");

            let basisAfter = basisBefore;
            let realized = 0;
            if (isExecute && input.succeeded && input.amountUsd != null) {
                const simulated: LedgerEvent = {
                    time: input.occurredAt ?? new Date(),
                    type: input.amountUsd > 0 ? "vaultDeposit" : "vaultWithdraw",
                    usdc: Math.abs(input.amountUsd),
                    netWithdrawnUsd:
                        input.amountUsd < 0 ? Math.abs(input.amountUsd) : undefined,
                    preEquityUsd: input.preEquityUsd ?? undefined,
                };
                const r = applyEvent(stateBefore, simulated);
                basisAfter = totalOpenBasis(r.state);
                realized = r.realizedPnl;
            }

            const unrealized =
                input.preEquityUsd != null && basisBefore > 0
                    ? input.preEquityUsd - basisBefore
                    : null;
            const roe =
                unrealized != null && basisBefore > 0
                    ? (unrealized / basisBefore) * 100
                    : null;

            await client.query(
                `INSERT INTO position_event (
                    round_id, vault_address, vault_snapshot_id, occurred_at, action,
                    amount_usd, pre_equity_usd, target_equity_usd, confidence,
                    reason_text, tx_meta_json, succeeded,
                    our_basis_usd_before, our_basis_usd_after,
                    our_realized_pnl_usd, our_unrealized_pnl_usd, our_roe_pct_at_decision,
                    platform_tvl_usd_at_event, hl_pnl_usd_at_decision
                ) VALUES ($1, $2, $3, COALESCE($4, now()), $5,
                          $6, $7, $8, $9, $10, $11, $12,
                          $13, $14, $15, $16, $17, $18, $19)`,
                [
                    input.roundId,
                    input.vaultAddress.toLowerCase(),
                    input.vaultSnapshotId,
                    input.occurredAt ?? null,
                    input.action,
                    input.amountUsd,
                    input.preEquityUsd,
                    input.targetEquityUsd,
                    input.confidence,
                    input.reasonText,
                    input.txMeta ?? null,
                    input.succeeded,
                    basisBefore,
                    isExecute && input.succeeded ? basisAfter : basisBefore,
                    isExecute && input.succeeded ? realized : 0,
                    unrealized,
                    roe,
                    input.platformTvlUsd,
                    input.hlPnlUsd,
                ]
            );
        });
    }

    /**
     * Upsert portfolio_series rows for the current moment. Stores HL's
     * `accountValueHistory` for HL portfolio context, plus our own
     * `vault_equity_usd` = sum of `getUserVaultEquities` (vault-only, no perps
     * wallet) at the current ts — that's what drives the PnL chart.
     */
    static async recordPortfolioPoint(): Promise<number> {
        const wallet = process.env.WALLET as `0x${string}` | undefined;
        if (!wallet) return 0;
        const [raw, vaultEquities] = await Promise.all([
            HyperliquidConnector.getUserPortfolioAllSeries(wallet).catch(() => null),
            HyperliquidConnector.getUserVaultEquities(wallet).catch(() => []),
        ]);
        if (!raw) return 0;
        let vaultEquityNow: number | null = null;
        if (Array.isArray(vaultEquities)) {
            vaultEquityNow = 0;
            for (const v of vaultEquities) {
                if (Number.isFinite(v.equity)) {
                    vaultEquityNow += Number(v.equity);
                }
            }
        }
        const pnlByTs = new Map<number, number>();
        for (const p of raw.pnl) pnlByTs.set(p.timestamp, p.value);
        const accByTs = new Map<number, number>();
        for (const p of raw.accountValue) accByTs.set(p.timestamp, p.value);
        let inserted = 0;
        await withDb("recordPortfolioPoint", async (client) => {
            const agg = await client.query<{ realized: string; basis: string }>(
                `SELECT
                    COALESCE(SUM(our_realized_pnl_usd_total), 0)::text AS realized,
                    COALESCE(SUM(our_basis_usd_open), 0)::text AS basis
                 FROM position_account`
            );
            const realized = Number(agg.rows[0]?.realized ?? 0);
            const basis = Number(agg.rows[0]?.basis ?? 0);
            // The CURRENT moment gets the vault_equity snapshot we just fetched.
            // Older ts (from HL day-window backfill) don't have a known
            // vault_equity — leave them null and let the chart fall back.
            const nowMs = Date.now();
            await client.query(
                `INSERT INTO portfolio_series (
                    ts, cumulative_pnl_usd, account_value_usd,
                    our_realized_pnl_usd, our_basis_usd_open, vault_equity_usd
                ) VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5, $6)
                ON CONFLICT (ts) DO UPDATE SET
                    cumulative_pnl_usd = EXCLUDED.cumulative_pnl_usd,
                    account_value_usd = EXCLUDED.account_value_usd,
                    our_realized_pnl_usd = EXCLUDED.our_realized_pnl_usd,
                    our_basis_usd_open = EXCLUDED.our_basis_usd_open,
                    vault_equity_usd = EXCLUDED.vault_equity_usd`,
                [
                    nowMs,
                    pnlByTs.get(nowMs) ?? null,
                    accByTs.get(nowMs) ?? null,
                    realized,
                    basis,
                    vaultEquityNow,
                ]
            );
            inserted += 1;
        });
        return inserted;
    }

    static async syncLedger(walletOverride?: `0x${string}`): Promise<number> {
        const wallet =
            walletOverride ?? (process.env.WALLET as `0x${string}` | undefined);
        if (!wallet) {
            logger.warn("syncLedger: no wallet configured");
            return 0;
        }
        let updates: UserLedgerUpdate[] = [];
        try {
            updates = await HyperliquidConnector.getUserVaultLedgerUpdates(wallet);
        } catch (error: any) {
            logger.warn("syncLedger: HL fetch failed", { message: error?.message });
            return 0;
        }
        let inserted = 0;
        await withDb("syncLedger", async (client) => {
            for (const u of updates) {
                if (!Number.isFinite(u.time) || !Number.isFinite(u.usdc)) continue;
                const r = await client.query(
                    `INSERT INTO position_ledger (
                        time, vault_address, type, usdc,
                        requested_usd, net_withdrawn_usd,
                        basis_usd_hl, commission_usd, closing_cost_usd
                    ) VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT ON CONSTRAINT position_ledger_unique DO NOTHING`,
                    [
                        u.time,
                        String(u.vault ?? "").toLowerCase(),
                        u.type,
                        u.usdc,
                        u.requestedUsd ?? null,
                        u.netWithdrawnUsd ?? null,
                        u.basisUsd ?? null,
                        u.commissionUsd ?? null,
                        u.closingCostUsd ?? null,
                    ]
                );
                if (r.rowCount) inserted += r.rowCount;
            }
        });
        if (inserted > 0) {
            const accounts = await recomputeAllAccounts();
            logger.info("syncLedger: ledger updated", {
                insertedRows: inserted,
                recomputedAccounts: accounts,
            });
        }
        return inserted;
    }
}

async function loadVaultLedgerEvents(
    client: PoolClient,
    vaultAddress: string
): Promise<LedgerEvent[]> {
    const r = await client.query<{
        time: Date;
        type: "vaultDeposit" | "vaultWithdraw";
        usdc: string;
        net_withdrawn_usd: string | null;
        basis_usd_hl: string | null;
    }>(
        `SELECT time, type, usdc, net_withdrawn_usd, basis_usd_hl
         FROM position_ledger
         WHERE LOWER(vault_address) = LOWER($1)
         ORDER BY time ASC, id ASC`,
        [vaultAddress]
    );
    return r.rows.map((row) => ({
        time: row.time,
        type: row.type,
        usdc: Number(row.usdc),
        netWithdrawnUsd:
            row.net_withdrawn_usd != null ? Number(row.net_withdrawn_usd) : null,
        basisUsdHl: row.basis_usd_hl != null ? Number(row.basis_usd_hl) : null,
    }));
}

// re-export recomputeAccountFor so callers can trigger after manual ledger writes
export { recomputeAccountFor };

export type LedgerHistoryEntry = {
    time: number;
    type: "vaultDeposit" | "vaultWithdraw";
    vaultAddress: string;
    amountUsd: number | null;
    realizedPnlUsdHl: number | null;
    realizedPnlUsdOurs: number | null;
};

export async function readLedgerHistory(options: {
    page: number;
    pageSize: number;
}): Promise<{
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    entries: LedgerHistoryEntry[];
} | null> {
    const page = Math.max(1, Math.floor(options.page) || 1);
    const pageSize = Math.max(1, Math.min(100, Math.floor(options.pageSize) || 15));
    const result = await withDb(
        "readLedgerHistory",
        async (client) => {
            const total = await client.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM position_ledger`
            );
            const totalCount = Number(total.rows[0]?.count ?? 0);
            const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
            const clampedPage = Math.min(page, totalPages);
            const offset = (clampedPage - 1) * pageSize;
            const rows = await client.query<{
                time: Date;
                type: "vaultDeposit" | "vaultWithdraw";
                vault_address: string;
                usdc: string;
                net_withdrawn_usd: string | null;
                basis_usd_hl: string | null;
            }>(
                `SELECT time, type, vault_address, usdc, net_withdrawn_usd, basis_usd_hl
                 FROM position_ledger
                 ORDER BY time DESC, id DESC
                 LIMIT $1 OFFSET $2`,
                [pageSize, offset]
            );
            const entries: LedgerHistoryEntry[] = rows.rows.map((r) => {
                const amount = Number(r.usdc);
                const realizedHl =
                    r.type === "vaultWithdraw" &&
                    r.net_withdrawn_usd != null &&
                    r.basis_usd_hl != null
                        ? Number(r.net_withdrawn_usd) - Number(r.basis_usd_hl)
                        : null;
                return {
                    time: r.time.getTime(),
                    type: r.type,
                    vaultAddress: r.vault_address,
                    amountUsd: Number.isFinite(amount) ? amount : null,
                    realizedPnlUsdHl: realizedHl,
                    realizedPnlUsdOurs: null, // populated below if needed
                };
            });
            return { totalCount, totalPages, clampedPage, entries };
        }
    );
    if (!result) return null;
    return {
        total: result.totalCount,
        page: result.clampedPage,
        pageSize,
        totalPages: result.totalPages,
        entries: result.entries,
    };
}

export async function readRecentRounds(limit: number) {
    return (
        (await withDb<any[]>("readRecentRounds", async (client) => {
            const r = await client.query(
                `SELECT id, started_at, completed_at, status, summary_json, error_text
                 FROM rebalance_round
                 ORDER BY started_at DESC
                 LIMIT $1`,
                [limit]
            );
            return r.rows;
        }, [])) ?? []
    );
}

export async function readRoundDetail(roundId: number) {
    return await withDb("readRoundDetail", async (client) => {
        const round = await client.query(
            `SELECT * FROM rebalance_round WHERE id = $1`,
            [roundId]
        );
        if (!round.rows.length) return null;
        const market = await client.query(
            `SELECT * FROM market_snapshot WHERE round_id = $1`,
            [roundId]
        );
        const claude = await client.query(
            `SELECT * FROM claude_decision WHERE round_id = $1 ORDER BY stage`,
            [roundId]
        );
        const snapshots = await client.query(
            `SELECT * FROM vault_snapshot WHERE round_id = $1`,
            [roundId]
        );
        const events = await client.query(
            `SELECT * FROM position_event WHERE round_id = $1 ORDER BY occurred_at ASC, id ASC`,
            [roundId]
        );
        return {
            round: round.rows[0],
            market: market.rows[0] ?? null,
            claudeDecisions: claude.rows,
            vaultSnapshots: snapshots.rows,
            positionEvents: events.rows,
        };
    });
}

export type PositionAccountAggregate = {
    realizedPnlTotal: number;
    basisOpenTotal: number;
    depositsTotal: number;
    withdrawsNetTotal: number;
    openVaults: number;
    closedVaults: number;
};

export async function readPositionAccountAggregate(): Promise<PositionAccountAggregate | null> {
    return await withDb("readPositionAccountAggregate", async (client) => {
        const r = await client.query<{
            realized_total: string | null;
            basis_open_total: string | null;
            deposits_total: string | null;
            withdraws_net_total: string | null;
            open_vaults: string;
            closed_vaults: string;
        }>(
            `SELECT
                COALESCE(SUM(our_realized_pnl_usd_total), 0)::text AS realized_total,
                COALESCE(SUM(our_basis_usd_open), 0)::text AS basis_open_total,
                COALESCE(SUM(cumulative_deposits_usd), 0)::text AS deposits_total,
                COALESCE(SUM(cumulative_withdraws_net_usd), 0)::text AS withdraws_net_total,
                SUM(CASE WHEN is_open THEN 1 ELSE 0 END)::text AS open_vaults,
                SUM(CASE WHEN NOT is_open THEN 1 ELSE 0 END)::text AS closed_vaults
             FROM position_account`
        );
        const row = r.rows[0];
        if (!row) return null;
        return {
            realizedPnlTotal: Number(row.realized_total),
            basisOpenTotal: Number(row.basis_open_total),
            depositsTotal: Number(row.deposits_total),
            withdrawsNetTotal: Number(row.withdraws_net_total),
            openVaults: Number(row.open_vaults),
            closedVaults: Number(row.closed_vaults),
        };
    });
}

export type WinRateAggregate = {
    totalClosures: number;
    wins: number;
};

/**
 * Per-vault win rate from our FIFO books.
 * A vault counts as "closed" once it has had at least one withdrawal AND
 * `our_realized_pnl_usd_total` is non-zero (excludes pure-deposit-no-history rows).
 * A vault counts as a "win" if its total realized PnL is positive.
 * Currently-open vaults with partial realizations also contribute (their
 * realized total reflects all closures so far).
 */
export async function readWinRateAggregate(): Promise<WinRateAggregate | null> {
    return await withDb("readWinRateAggregate", async (client) => {
        const r = await client.query<{
            total: string;
            wins: string;
        }>(
            `SELECT
                COUNT(*) FILTER (
                    WHERE withdraw_count > 0
                )::text AS total,
                COUNT(*) FILTER (
                    WHERE withdraw_count > 0
                      AND our_realized_pnl_usd_total > 0
                )::text AS wins
             FROM position_account`
        );
        const row = r.rows[0];
        if (!row) return null;
        return {
            totalClosures: Number(row.total),
            wins: Number(row.wins),
        };
    });
}

/**
 * Max drawdown of our portfolio equity since launch, computed from the
 * `portfolio_series.account_value_usd` column we mirror from HL.
 * Returns the peak-to-trough decline as a negative percentage (e.g. -19.5).
 */
export async function readMaxDrawdownFromSeries(
    sinceMs: number
): Promise<number | null> {
    return await withDb<number | null>("readMaxDrawdownFromSeries", async (client) => {
        const r = await client.query<{
            ts: Date;
            account_value_usd: string | null;
        }>(
            `SELECT ts, account_value_usd
             FROM portfolio_series
             WHERE ts >= to_timestamp($1 / 1000.0)
               AND account_value_usd IS NOT NULL
             ORDER BY ts ASC`,
            [sinceMs]
        );
        if (!r.rows.length) return null;
        let peak = -Infinity;
        let maxDdPct = 0;
        for (const row of r.rows) {
            const v = Number(row.account_value_usd);
            if (!Number.isFinite(v) || v <= 0) continue;
            if (v > peak) peak = v;
            if (peak > 0) {
                const dd = (v - peak) / peak;
                if (dd < maxDdPct) maxDdPct = dd;
            }
        }
        return maxDdPct === 0 && peak === -Infinity ? null : maxDdPct * 100;
    }, null as any);
}

export type PortfolioSeriesSnapshot = {
    ts: number;
    cumulativePnlUsd: number | null;
    accountValueUsd: number | null;
    ourRealizedPnlUsd: number | null;
    ourBasisUsdOpen: number | null;
};

export async function readPortfolioSnapshotAt(targetMs: number): Promise<PortfolioSeriesSnapshot | null> {
    return await withDb("readPortfolioSnapshotAt", async (client) => {
        const r = await client.query<{
            ts: Date;
            cumulative_pnl_usd: string | null;
            account_value_usd: string | null;
            our_realized_pnl_usd: string | null;
            our_basis_usd_open: string | null;
        }>(
            `SELECT ts, cumulative_pnl_usd, account_value_usd,
                    our_realized_pnl_usd, our_basis_usd_open
             FROM portfolio_series
             WHERE ts <= to_timestamp($1 / 1000.0)
             ORDER BY ts DESC
             LIMIT 1`,
            [targetMs]
        );
        const row = r.rows[0];
        if (!row) return null;
        return {
            ts: row.ts.getTime(),
            cumulativePnlUsd: row.cumulative_pnl_usd != null ? Number(row.cumulative_pnl_usd) : null,
            accountValueUsd: row.account_value_usd != null ? Number(row.account_value_usd) : null,
            ourRealizedPnlUsd: row.our_realized_pnl_usd != null ? Number(row.our_realized_pnl_usd) : null,
            ourBasisUsdOpen: row.our_basis_usd_open != null ? Number(row.our_basis_usd_open) : null,
        };
    });
}

export type NetCashFlowPoint = {
    timestamp: number;
    netCashDeployedUsd: number;
};

/**
 * Returns cumulative net-cash-deployed (deposits − netWithdraws) per ledger
 * event timestamp. Walked alongside `portfolio_series` in the chart endpoint
 * to compute true PnL = accountValue − netCashDeployed, which is independent
 * of the perps-wallet vs vault-equity split inside HL's reported accountValue.
 */
export async function readNetCashFlowTimeline(): Promise<NetCashFlowPoint[]> {
    return (
        (await withDb<NetCashFlowPoint[]>(
            "readNetCashFlowTimeline",
            async (client) => {
                const r = await client.query<{
                    time: Date;
                    type: "vaultDeposit" | "vaultWithdraw";
                    usdc: string;
                    net_withdrawn_usd: string | null;
                }>(
                    `SELECT time, type, usdc, net_withdrawn_usd
                     FROM position_ledger
                     ORDER BY time ASC, id ASC`
                );
                let running = 0;
                const points: NetCashFlowPoint[] = [];
                for (const row of r.rows) {
                    if (row.type === "vaultDeposit") {
                        running += Number(row.usdc);
                    } else {
                        const net =
                            row.net_withdrawn_usd != null
                                ? Number(row.net_withdrawn_usd)
                                : Number(row.usdc);
                        running -= net;
                    }
                    points.push({
                        timestamp: row.time.getTime(),
                        netCashDeployedUsd: running,
                    });
                }
                return points;
            },
            []
        )) ?? []
    );
}

export async function readPortfolioSeries(): Promise<{
    pnl: { points: { timestamp: number; value: number }[] };
    accountValue: { points: { timestamp: number; value: number }[] };
    vaultEquity: { points: { timestamp: number; value: number }[] };
    ourRealizedPnl: { points: { timestamp: number; value: number }[] };
    ourBasisOpen: { points: { timestamp: number; value: number }[] };
} | null> {
    return await withDb("readPortfolioSeries", async (client) => {
        const r = await client.query<{
            ts: Date;
            cumulative_pnl_usd: string | null;
            account_value_usd: string | null;
            vault_equity_usd: string | null;
            our_realized_pnl_usd: string | null;
            our_basis_usd_open: string | null;
        }>(
            `SELECT ts, cumulative_pnl_usd, account_value_usd, vault_equity_usd,
                    our_realized_pnl_usd, our_basis_usd_open
             FROM portfolio_series
             ORDER BY ts ASC`
        );
        const pnl: { timestamp: number; value: number }[] = [];
        const accountValue: { timestamp: number; value: number }[] = [];
        const vaultEquity: { timestamp: number; value: number }[] = [];
        const ourRealizedPnl: { timestamp: number; value: number }[] = [];
        const ourBasisOpen: { timestamp: number; value: number }[] = [];
        for (const row of r.rows) {
            const ts = row.ts.getTime();
            if (row.cumulative_pnl_usd != null) {
                pnl.push({ timestamp: ts, value: Number(row.cumulative_pnl_usd) });
            }
            if (row.account_value_usd != null) {
                accountValue.push({ timestamp: ts, value: Number(row.account_value_usd) });
            }
            if (row.vault_equity_usd != null) {
                vaultEquity.push({ timestamp: ts, value: Number(row.vault_equity_usd) });
            }
            if (row.our_realized_pnl_usd != null) {
                ourRealizedPnl.push({ timestamp: ts, value: Number(row.our_realized_pnl_usd) });
            }
            if (row.our_basis_usd_open != null) {
                ourBasisOpen.push({ timestamp: ts, value: Number(row.our_basis_usd_open) });
            }
        }
        return {
            pnl: { points: pnl },
            accountValue: { points: accountValue },
            vaultEquity: { points: vaultEquity },
            ourRealizedPnl: { points: ourRealizedPnl },
            ourBasisOpen: { points: ourBasisOpen },
        };
    });
}

export async function readVaultTimeline(vaultAddress: string, limit: number) {
    return (
        (await withDb<any[]>("readVaultTimeline", async (client) => {
            const r = await client.query(
                `SELECT pe.*, vs.tvl_usd AS snap_tvl_usd, vs.net_direction AS snap_net_direction
                 FROM position_event pe
                 LEFT JOIN vault_snapshot vs ON pe.vault_snapshot_id = vs.id
                 WHERE LOWER(pe.vault_address) = LOWER($1)
                 ORDER BY pe.occurred_at DESC, pe.id DESC
                 LIMIT $2`,
                [vaultAddress, limit]
            );
            return r.rows;
        }, [])) ?? []
    );
}
