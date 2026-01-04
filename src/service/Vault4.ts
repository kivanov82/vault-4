import { VaultService } from "./vaults/VaultService";
import { logger } from "./utils/logger";

export class Vault4 {

    static async init(): Promise<any> {
        logger.info("Vault service initializing");
        await VaultService.warm();
    }
}
