import "dotenv/config";
import { runMigrations } from "../src/db/migrate";
import { withDb } from "../src/db/pool";
import { HyperliquidConnector } from "../src/service/trade/HyperliquidConnector";
import {
    applyEvent,
    createEmptyState,
    totalOpenBasis,
    type AccountState,
    type LedgerEvent,
} from "../src/db/PositionAccountService";

async function main() {
    await runMigrations();
    const wallet = process.env.WALLET as `0x${string}` | undefined;
    if (!wallet) {
        console.error("WALLET env not set");
        process.exit(1);
    }
    // Wipe any prior portfolio_series rows so a re-run can correct stored data
    // (e.g. rows from an earlier code path that stored already-rebased values).
    await withDb("backfill-series.wipe", async (client) => {
        await client.query("TRUNCATE portfolio_series");
    });
    const series = await HyperliquidConnector.getUserPortfolioAllSeries(wallet);
    if (!series) {
        console.error("No portfolio history available");
        process.exit(1);
    }

    const pnlByTs = new Map<number, number>();
    for (const p of series.pnl) pnlByTs.set(p.timestamp, p.value);
    const eqByTs = new Map<number, number>();
    for (const p of series.accountValue) eqByTs.set(p.timestamp, p.value);
    const perpEqByTs = new Map<number, number>();
    for (const p of series.perpAccountValue) perpEqByTs.set(p.timestamp, p.value);

    const allTs = new Set<number>([
        ...pnlByTs.keys(),
        ...eqByTs.keys(),
        ...perpEqByTs.keys(),
    ]);
    const sortedTs = [...allTs].sort((a, b) => a - b);
    console.log(
        `Merged ${sortedTs.length} unique timestamps across allTime/month/week/day windows (${series.perpAccountValue.length} perps points)`
    );

    let inserted = 0;
    await withDb("backfill-series.upsert", async (client) => {
        const ledger = await client.query<{
            time: Date;
            type: "vaultDeposit" | "vaultWithdraw";
            vault_address: string;
            usdc: string;
            net_withdrawn_usd: string | null;
            basis_usd_hl: string | null;
        }>(
            `SELECT time, type, vault_address, usdc, net_withdrawn_usd, basis_usd_hl
             FROM position_ledger
             ORDER BY time ASC, id ASC`
        );
        // One sorted list of (ts, vault, event), plus per-vault running state.
        type RowEvent = LedgerEvent & { vault: string };
        const allEvents: RowEvent[] = ledger.rows.map((row) => ({
            time: row.time,
            type: row.type,
            usdc: Number(row.usdc),
            netWithdrawnUsd:
                row.net_withdrawn_usd != null
                    ? Number(row.net_withdrawn_usd)
                    : null,
            basisUsdHl:
                row.basis_usd_hl != null ? Number(row.basis_usd_hl) : null,
            vault: row.vault_address.toLowerCase(),
        }));
        allEvents.sort((a, b) => a.time.getTime() - b.time.getTime());

        const states = new Map<string, AccountState>();
        let runningRealized = 0;
        let runningBasis = 0;
        let cursor = 0;
        for (const ts of sortedTs) {
            while (
                cursor < allEvents.length &&
                allEvents[cursor].time.getTime() <= ts
            ) {
                const ev = allEvents[cursor];
                const prev = states.get(ev.vault) ?? createEmptyState(ev.vault);
                const prevBasis = totalOpenBasis(prev);
                const r = applyEvent(prev, ev);
                const nextBasis = totalOpenBasis(r.state);
                runningBasis += nextBasis - prevBasis;
                runningRealized += r.realizedPnl;
                states.set(ev.vault, r.state);
                cursor += 1;
            }
            const accValue = eqByTs.get(ts);
            const perpAcc = perpEqByTs.get(ts);
            // vault-only equity = total acc − perps acc. Both must be present;
            // otherwise leave null and the chart falls back to acc.
            const vaultEquity =
                accValue != null && perpAcc != null ? accValue - perpAcc : null;
            const result = await client.query(
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
                    ts,
                    pnlByTs.get(ts) ?? null,
                    accValue ?? null,
                    runningRealized,
                    runningBasis,
                    vaultEquity,
                ]
            );
            if (result.rowCount) inserted += result.rowCount;
        }
    });

    console.log(JSON.stringify({ pointsProcessed: sortedTs.length, inserted }, null, 2));
    process.exit(0);
}

main().catch((err) => {
    console.error("backfill-series failed:", err);
    process.exit(1);
});
