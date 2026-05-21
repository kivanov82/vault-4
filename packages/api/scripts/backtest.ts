/*
 * Decision-logic backtest harness — stub.
 *
 * Goal: replay the rebalance Pass-1/Pass-2 rule logic against persisted
 * Claude outputs + vault snapshots + position ledger, with overridden config,
 * to simulate alternative outcomes without re-calling Claude or the network.
 *
 * Data sources used:
 *   - rebalance_round            — iterate in chronological order
 *   - claude_decision (stage=2)  — barbell allocations frozen at the time
 *   - vault_snapshot              — per-vault context the decision was made under
 *   - position_event              — what we actually did (ground truth for the diff)
 *   - position_ledger / position_account — for FIFO basis math
 *   - market_snapshot             — preferred_direction at decision time
 *
 * Config to override (read from CLI args / env):
 *   - STOP_LOSS_PCT, HARD_STOP_LOSS_PCT
 *   - MIN_HOLD_DAYS
 *   - DEPOSIT_HIGH_PCT / DEPOSIT_LOW_PCT (barbell split)
 *   - MAX_SAME_DIRECTION_PCT
 *
 * Output: per-round simulated decisions, simulated realized PnL trajectory,
 * and a diff vs. actual position_event rows.
 *
 * Not yet implemented. See plan file:
 *   /Users/kirilivanov/.claude/plans/jiggly-stargazing-torvalds.md  (§7)
 */

import "dotenv/config";
import { withDb } from "../src/db/pool";

type SimConfig = {
    stopLossPct: number;
    hardStopLossPct: number;
    minHoldDays: number;
    highPct: number;
    lowPct: number;
};

const DEFAULT_CONFIG: SimConfig = {
    stopLossPct: -15,
    hardStopLossPct: -25,
    minHoldDays: 5,
    highPct: 80,
    lowPct: 20,
};

async function listRounds() {
    return (
        (await withDb<any[]>("backtest.listRounds", async (client) => {
            const r = await client.query(
                `SELECT id, started_at, status, summary_json
                 FROM rebalance_round
                 WHERE status = 'completed'
                 ORDER BY started_at ASC`
            );
            return r.rows;
        }, [])) ?? []
    );
}

async function main() {
    const config: SimConfig = { ...DEFAULT_CONFIG };
    const rounds = await listRounds();
    console.log(`Loaded ${rounds.length} completed rounds.`);
    console.log("Backtest config:", config);
    // TODO:
    //   for each round:
    //     load claude_decision (stage=2) → barbell + allocations
    //     load vault_snapshot rows → per-vault decision context
    //     load market_snapshot.preferred_direction
    //     replay Pass-1 (trim over-allocated) + Pass-2 (exits/holds) with config
    //     compute simulated PnL trajectory using PositionAccountService.replayLedger
    //     diff vs actual position_event rows
    //   summarize aggregate simulated PnL vs actual realized
    process.exit(0);
}

main().catch((err) => {
    console.error("backtest failed:", err);
    process.exit(1);
});
