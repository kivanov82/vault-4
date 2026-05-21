import { RebalanceScheduler } from "./rebalance/RebalanceScheduler";
import { SettlementScheduler } from "./settlement/SettlementScheduler";
import { PlatformSnapshotService } from "./vaults/PlatformSnapshotService";
import { logger } from "./utils/logger";
import { runMigrations } from "../db/migrate";
import { TraceService } from "../db/TraceService";

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
        TraceService.syncLedger().catch((error) => {
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
    }
}
