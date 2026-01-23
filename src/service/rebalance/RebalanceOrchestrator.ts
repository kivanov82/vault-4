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
    tpWithdrawals: VaultTransferAction[];
    withdrawals: VaultTransferAction[];
    deposits: Awaited<ReturnType<typeof DepositService.executeDepositPlan>> | null;
};

const DEFAULT_WITHDRAWAL_DELAY_MS = Number(
    process.env.REBALANCE_WITHDRAWAL_DELAY_MS ?? 60000
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

        // Use recommendations from the plan (already fetched in buildDepositPlan)
        const recommendations = plan.recommendations;

        // Build target allocations map (barbell strategy)
        const targetAllocations = buildTargetAllocations(
            recommendations,
            plan.totalCapitalUsd
        );

        // TP Strategy: Partial withdrawals from over-allocated positions
        const TP_THRESHOLD_PCT = 10; // Hardcoded 10% profit threshold
        const tpWithdrawals: VaultTransferAction[] = [];

        for (const position of positions.positions) {
            const address = position.vaultAddress.toLowerCase();

            // Only process vaults still in recommendations
            if (!recommendedSet.has(address)) {
                continue;
            }

            // Check if profitable enough for TP
            const roePct = position.roePct ?? 0;
            if (roePct < TP_THRESHOLD_PCT) {
                continue;
            }

            // Check if over-allocated
            const targetAllocation = targetAllocations.get(address);
            if (!targetAllocation) {
                continue;
            }

            const currentUsd = position.amountUsd ?? 0;
            const targetUsd = targetAllocation.targetUsd;

            if (currentUsd <= targetUsd) {
                // Under-allocated or at target, keep it
                continue;
            }

            logger.info("Take-profit opportunity detected", {
                vaultAddress: address,
                vaultName: position.vaultName,
                currentUsd,
                targetUsd,
                excessUsd: currentUsd - targetUsd,
                roePct,
                confidence: targetAllocation.confidence,
            });

            // Execute partial withdrawal to bring position to target
            const result = await RebalanceService.withdrawPartialFromVault({
                vaultAddress: address as `0x${string}`,
                targetAmountUsd: targetUsd,
                dryRun,
            });

            if (result.action.status === "submitted" || result.action.status === "prepared") {
                logger.info("Take-profit withdrawal executed", {
                    vaultAddress: address,
                    vaultName: position.vaultName,
                    withdrawnUsd: (result.action.usdMicros ?? 0) / 1e6,
                    remainingUsd: targetUsd,
                    roePct,
                    dryRun,
                });
            }

            tpWithdrawals.push(result.action);
        }

        // Full exit from non-recommended vaults (existing logic)
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
            (withdrawals.some((action) => action.status === "submitted") ||
                tpWithdrawals.some((action) => action.status === "submitted"))
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
            tpWithdrawals: tpWithdrawals.length,
            withdrawals: withdrawals.length,
            depositsSubmitted: deposits.submitted,
            dryRun,
        });

        return {
            startedAt,
            planTargets: plan.targets.length,
            recommended,
            tpWithdrawals,
            withdrawals,
            deposits,
        };
    }
}

function buildTargetAllocations(
    recommendations: Awaited<ReturnType<typeof VaultService.getRecommendations>>,
    totalCapitalUsd: number
): Map<string, { targetUsd: number; confidence: "high" | "low" }> {
    const allocations = new Map<string, { targetUsd: number; confidence: "high" | "low" }>();

    // Use barbell strategy: split total capital between confidence groups
    const highCount = recommendations.highConfidence.length;
    const lowCount = recommendations.lowConfidence.length;

    if (highCount === 0 && lowCount === 0) {
        return allocations;
    }

    // Get group percentages from env or use defaults (80/20 split)
    const DEFAULT_HIGH_PCT = Number(process.env.DEPOSIT_HIGH_PCT || 80);
    const DEFAULT_LOW_PCT = Number(process.env.DEPOSIT_LOW_PCT || 20);

    const highTotalUsd = totalCapitalUsd * (DEFAULT_HIGH_PCT / 100);
    const lowTotalUsd = totalCapitalUsd * (DEFAULT_LOW_PCT / 100);

    // Split evenly within each group
    const targetPerHighVault = highCount > 0 ? highTotalUsd / highCount : 0;
    const targetPerLowVault = lowCount > 0 ? lowTotalUsd / lowCount : 0;

    for (const rec of recommendations.highConfidence) {
        allocations.set(rec.vaultAddress.toLowerCase(), {
            targetUsd: targetPerHighVault,
            confidence: "high",
        });
    }

    for (const rec of recommendations.lowConfidence) {
        allocations.set(rec.vaultAddress.toLowerCase(), {
            targetUsd: targetPerLowVault,
            confidence: "low",
        });
    }

    return allocations;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
