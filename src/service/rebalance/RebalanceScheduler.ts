import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import { logger } from "../utils/logger";
import { RebalanceOrchestrator } from "./RebalanceOrchestrator";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 2 * MS_PER_DAY;

export class RebalanceScheduler {
    private static started = false;
    private static running = false;
    private static intervalHandle: NodeJS.Timeout | null = null;
    private static startHandle: NodeJS.Timeout | null = null;

    static async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        if ((process.env.REBALANCE_ENABLED ?? "true") === "false") {
            logger.info("Rebalance scheduler disabled");
            return;
        }

        const intervalMs = readNumberEnv(
            process.env.REBALANCE_INTERVAL_MS,
            DEFAULT_INTERVAL_MS
        );
        if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
            logger.warn("Rebalance scheduler disabled due to invalid interval", {
                intervalMs,
            });
            return;
        }

        const lastDepositTime = await getLastDepositTime();
        const now = Date.now();
        const elapsed = lastDepositTime ? now - lastDepositTime : null;
        const initialDelay =
            elapsed !== null && elapsed < intervalMs ? intervalMs - elapsed : 0;

        logger.info("Rebalance scheduler initialized", {
            intervalMs,
            lastDepositTime,
            initialDelay,
        });

        this.startHandle = setTimeout(async () => {
            await this.runOnce();
            this.intervalHandle = setInterval(() => {
                void this.runOnce();
            }, intervalMs);
        }, Math.max(0, initialDelay));
    }

    static async runOnce(): Promise<void> {
        if (this.running) {
            logger.warn("Rebalance skipped: previous run still in progress");
            return;
        }
        this.running = true;
        try {
            await RebalanceOrchestrator.runRound({
                dryRun: (process.env.REBALANCE_DRY_RUN ?? "true") !== "false",
                refreshCandidates: true,
                refreshRecommendations: true,
            });
        } catch (error: any) {
            logger.warn("Rebalance round failed", { message: error?.message });
        } finally {
            this.running = false;
        }
    }
}

async function getLastDepositTime(): Promise<number | null> {
    const wallet = process.env.WALLET as `0x${string}` | undefined;
    if (!wallet) return null;
    const updates = await HyperliquidConnector.getUserVaultLedgerUpdates(wallet);
    let latest: number | null = null;
    for (const update of updates) {
        if (update.type !== "vaultDeposit") continue;
        if (!Number.isFinite(update.time)) continue;
        if (latest === null || update.time > latest) {
            latest = update.time;
        }
    }
    return latest;
}

function readNumberEnv(value: any, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}
