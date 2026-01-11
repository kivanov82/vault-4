import {DepositPlan, DepositService} from "./rebalance/DepositService";
import { VaultService } from "./vaults/VaultService";
import { logger } from "./utils/logger";

export class Vault4 {

    static async init(): Promise<any> {
        logger.info("Vault service initializing");
        try {
            const plan = await DepositService.buildDepositPlan({ refreshCandidates: true });
            await DepositService.executeDepositPlan(plan, {dryRun: false, minDepositUsd: 1});
        } catch (error: any) {
            logger.warn("Failed to build deposit plan during startup", {
                message: error?.message,
            });
        }
    }
}
