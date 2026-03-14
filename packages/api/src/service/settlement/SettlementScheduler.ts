import { logger } from "../utils/logger";
import { VaultContractService } from "./VaultContractService";

/**
 * Daily settlement at 3PM CET (14:00 UTC winter / 13:00 UTC summer).
 * Runs: updateTotalAssets → settle → sweepToL1
 */
export class SettlementScheduler {
    private static started = false;
    private static running = false;
    private static timeoutHandle: NodeJS.Timeout | null = null;

    static async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        if ((process.env.SETTLEMENT_ENABLED ?? "true") === "false") {
            logger.info("Settlement scheduler disabled");
            return;
        }

        if (!process.env.VAULT4FUND_ADDRESS) {
            logger.info("Settlement scheduler disabled: VAULT4FUND_ADDRESS not set");
            return;
        }

        this.scheduleNext();
        logger.info("Settlement scheduler initialized");
    }

    /**
     * Schedule the next settlement run at 14:00 UTC (≈3PM CET).
     */
    private static scheduleNext(): void {
        const now = new Date();
        const target = new Date(now);
        target.setUTCHours(14, 0, 0, 0);

        // If we've already passed 14:00 UTC today, schedule for tomorrow
        if (now >= target) {
            target.setUTCDate(target.getUTCDate() + 1);
        }

        const delayMs = target.getTime() - now.getTime();
        logger.info("Settlement scheduled", {
            nextRun: target.toISOString(),
            delayMs,
            delayHours: (delayMs / 3_600_000).toFixed(1),
        });

        this.timeoutHandle = setTimeout(async () => {
            await this.runOnce();
            this.scheduleNext();
        }, delayMs);
    }

    static async runOnce(): Promise<void> {
        if (this.running) {
            logger.warn("Settlement skipped: previous run still in progress");
            return;
        }
        this.running = true;
        try {
            await VaultContractService.runSettlement({ dryRun: false });
        } catch (error: any) {
            logger.warn("Settlement round failed", { message: error?.message });
        } finally {
            this.running = false;
        }
    }
}
