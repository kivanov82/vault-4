import { logger } from "../utils/logger";
import { XPostService } from "./XPostService";

const MIN_HOURS = Number(process.env.X_POST_MIN_HOURS ?? 14);
const MAX_HOURS = Number(process.env.X_POST_MAX_HOURS ?? 34);

/**
 * Daily X post with ±10h jitter (default 14-34h between posts) so the
 * publishing time drifts across the day instead of always firing at the
 * same UTC hour. Independent of settlement.
 */
export class XPostScheduler {
    private static started = false;
    private static timeoutHandle: NodeJS.Timeout | null = null;

    static async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
        if ((process.env.X_POST_ENABLED ?? "true") === "false") {
            logger.info("X post scheduler disabled");
            return;
        }
        if (!XPostService.isConfigured()) {
            logger.info("X post scheduler disabled: X API not configured");
            return;
        }
        this.scheduleNext();
        logger.info("X post scheduler initialized");
    }

    private static scheduleNext(): void {
        const min = Math.max(1, MIN_HOURS);
        const max = Math.max(min + 1, MAX_HOURS);
        const hours = min + Math.random() * (max - min);
        const delayMs = Math.floor(hours * 3_600_000);
        const target = new Date(Date.now() + delayMs);
        logger.info("X post scheduled", {
            nextRun: target.toISOString(),
            delayHours: hours.toFixed(2),
        });
        this.timeoutHandle = setTimeout(async () => {
            try {
                await XPostService.runDailyPost();
            } catch (error: any) {
                logger.warn("X post run failed", { message: error?.message });
            }
            this.scheduleNext();
        }, delayMs);
    }
}
