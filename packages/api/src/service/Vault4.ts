import { RebalanceScheduler } from "./rebalance/RebalanceScheduler";
import { SettlementScheduler } from "./settlement/SettlementScheduler";
import { PlatformSnapshotService } from "./vaults/PlatformSnapshotService";
import { XPostScheduler } from "./social/XPostScheduler";
import { logger } from "./utils/logger";
import { runMigrations } from "../db/migrate";
import {
    TraceService,
    backfillEventBasisFromLedger,
    backfillPortfolioSeriesFromLedger,
} from "../db/TraceService";
import { recomputeAllAccounts } from "../db/PositionAccountService";

const LEDGER_SYNC_INTERVAL_MS = Number(
    process.env.LEDGER_SYNC_INTERVAL_MS ?? 5 * 60 * 1000
);

export class Vault4 {

    static async init(): Promise<any> {
        logger.info("Vault service initializing");
        try {
            await runMigrations();
        } catch (error: any) {
            logger.error("Migration run failed (continuing)", {
                message: error?.message,
            });
        }
        TraceService.syncLedger()
            .then(async () => {
                // Always recompute on boot — FIFO logic may have changed since
                // the last sync (eg. the 2026-05-22 zero-amount-withdraw fix
                // required rebuilding accounts from `position_ledger`).
                try {
                    const n = await recomputeAllAccounts();
                    logger.info("Recomputed position accounts on startup", {
                        accounts: n,
                    });
                    // Rewrite historical position_event basis fields from
                    // the freshly-recomputed ledger replay. Idempotent: only
                    // touches rows whose stored values drift from the replay.
                    try {
                        const fixed = await backfillEventBasisFromLedger();
                        logger.info("Backfilled position_event basis", {
                            rowsUpdated: fixed,
                        });
                    } catch (error: any) {
                        logger.warn("Startup event-basis backfill failed", {
                            message: error?.message,
                        });
                    }
                    try {
                        const fixedSeries =
                            await backfillPortfolioSeriesFromLedger();
                        logger.info("Backfilled portfolio_series aggregates", {
                            rowsUpdated: fixedSeries,
                        });
                    } catch (error: any) {
                        logger.warn(
                            "Startup portfolio_series backfill failed",
                            { message: error?.message }
                        );
                    }
                    // Stamp a fresh portfolio_series row so the chart picks
                    // up the corrected realized/basis aggregates immediately
                    // instead of waiting for the next rebalance round.
                    await TraceService.recordPortfolioPoint().catch((error) => {
                        logger.warn("Startup recordPortfolioPoint failed", {
                            message: error?.message,
                        });
                    });
                } catch (error: any) {
                    logger.warn("Startup account recompute failed", {
                        message: error?.message,
                    });
                }
            })
            .catch((error) => {
                logger.warn("Initial ledger sync failed", {
                    message: error?.message,
                });
            });
        setInterval(() => {
            TraceService.syncLedger().catch((error) => {
                logger.warn("Periodic ledger sync failed", {
                    message: error?.message,
                });
            });
        }, LEDGER_SYNC_INTERVAL_MS);
        PlatformSnapshotService.start().catch((error) => {
            logger.error("Platform snapshot startup failed", {
                message: error?.message,
            });
        });
        await RebalanceScheduler.start();
        await SettlementScheduler.start();
        await XPostScheduler.start();
    }
}
