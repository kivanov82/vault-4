import { RebalanceScheduler } from "./rebalance/RebalanceScheduler";
import { SettlementScheduler } from "./settlement/SettlementScheduler";
import { PlatformSnapshotService } from "./vaults/PlatformSnapshotService";
import { logger } from "./utils/logger";

export class Vault4 {

    static async init(): Promise<any> {
        logger.info("Vault service initializing");
        PlatformSnapshotService.start().catch((error) => {
            logger.error("Platform snapshot startup failed", {
                message: error?.message,
            });
        });
        await RebalanceScheduler.start();
        await SettlementScheduler.start();
    }
}
