import { DepositService } from "./DepositService";
import { RebalanceService, type VaultTransferAction } from "./RebalanceService";
import { VaultService } from "../vaults/VaultService";
import { logger } from "../utils/logger";

export type RebalanceRoundOptions = {
    dryRun?: boolean;
    includeLocked?: boolean;
    refreshCandidates?: boolean;
    refreshRecommendations?: boolean;
    minDepositUsd?: number;
    withdrawalDelayMs?: number;
};

export type RebalanceRoundResult = {
    startedAt: string;
    planTargets: number;
    recommended: string[];
    withdrawals: VaultTransferAction[];
    deposits: Awaited<ReturnType<typeof DepositService.executeDepositPlan>> | null;
};

const DEFAULT_WITHDRAWAL_DELAY_MS = Number(
    process.env.REBALANCE_WITHDRAWAL_DELAY_MS ?? 0
);

export class RebalanceOrchestrator {
    static async runRound(
        options: RebalanceRoundOptions = {}
    ): Promise<RebalanceRoundResult> {
        const startedAt = new Date().toISOString();
        const dryRun = options.dryRun ?? true;
        const includeLocked = options.includeLocked ?? false;
        const minDepositUsd = options.minDepositUsd ?? 1;
        const withdrawalDelayMs =
            options.withdrawalDelayMs ?? DEFAULT_WITHDRAWAL_DELAY_MS;

        logger.info("Rebalance round starting", {
            startedAt,
            dryRun,
            includeLocked,
        });

        const plan = await DepositService.buildDepositPlan({
            refreshCandidates: options.refreshCandidates,
            refreshRecommendations: options.refreshRecommendations,
            maxActive: 10,
        });

        const recommended = plan.targets.map((target) =>
            target.vaultAddress.toLowerCase()
        );
        const recommendedSet = new Set(recommended);

        const positions = await VaultService.getPlatformPositions({
            refresh: options.refreshRecommendations ?? options.refreshCandidates,
        });

        const withdrawals: VaultTransferAction[] = [];
        for (const position of positions.positions) {
            const address = position.vaultAddress.toLowerCase();
            if (recommendedSet.has(address)) {
                continue;
            }
            const pnlUsd =
                typeof position.pnlUsd === "number" ? position.pnlUsd : null;
            if (!Number.isFinite(pnlUsd) || pnlUsd <= 0) {
                logger.info("Skipping withdrawal (non-positive PnL)", {
                    vaultAddress: position.vaultAddress,
                    pnlUsd,
                });
                continue;
            }
            const result = await RebalanceService.withdrawAllFromVault({
                vaultAddress: position.vaultAddress as `0x${string}`,
                dryRun,
                includeLocked,
                sweepDust: true,
            });
            withdrawals.push(result.action);
        }

        if (
            withdrawalDelayMs > 0 &&
            withdrawals.some((action) => action.status === "submitted")
        ) {
            logger.info("Waiting for withdrawals to settle", {
                withdrawalDelayMs,
            });
            await sleep(withdrawalDelayMs);
        }

        const deposits = await DepositService.executeDepositPlan(plan, {
            dryRun,
            minDepositUsd,
        });

        logger.info("Rebalance round completed", {
            startedAt,
            withdrawals: withdrawals.length,
            depositsSubmitted: deposits.submitted,
            dryRun,
        });

        return {
            startedAt,
            planTargets: plan.targets.length,
            recommended,
            withdrawals,
            deposits,
        };
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
