import { RebalanceScheduler } from "./rebalance/RebalanceScheduler";
import { logger } from "./utils/logger";

export class Vault4 {

    static async init(): Promise<any> {
        logger.info("Vault service initializing");
        await RebalanceScheduler.start();
    }
}
