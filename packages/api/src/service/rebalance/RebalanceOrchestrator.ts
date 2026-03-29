import { DepositService } from "./DepositService";
import { RebalanceService, type VaultTransferAction } from "./RebalanceService";
import { VaultService } from "../vaults/VaultService";
import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import { MarketDataService } from "../claude/MarketDataService";
import { logger } from "../utils/logger";

const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT ?? -15);
const HARD_STOP_LOSS_PCT = Number(process.env.HARD_STOP_LOSS_PCT ?? -25);
const MIN_HOLD_DAYS = Number(process.env.MIN_HOLD_DAYS ?? 5);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
        const minDepositUsd = options.minDepositUsd ?? 5;
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

        // Build recommended set from the FULL recommendation list (before exposure filtering),
        // not just deposit targets. Deposit targets exclude vaults we already hold,
        // but we need to know if our current positions are still recommended by Claude.
        const allRecommended = [
            ...plan.recommendations.highConfidence,
            ...plan.recommendations.lowConfidence,
        ];
        const recommended = allRecommended.map((rec) =>
            rec.vaultAddress.toLowerCase()
        );
        const recommendedSet = new Set(recommended);

        logger.info("Recommendation set built", {
            source: plan.recommendations.source,
            model: plan.recommendations.model,
            totalRecommended: recommendedSet.size,
            highConfidence: plan.recommendations.highConfidence.map(r => ({
                name: r.name, score: r.score, address: r.vaultAddress,
            })),
            lowConfidence: plan.recommendations.lowConfidence.map(r => ({
                name: r.name, score: r.score, address: r.vaultAddress,
            })),
            depositTargets: plan.targets.length,
            totalCapitalUsd: plan.totalCapitalUsd,
            availableBalanceUsd: plan.availableBalanceUsd,
        });

        const positions = await VaultService.getPlatformPositions({
            refresh: options.refreshRecommendations ?? options.refreshCandidates,
        });

        logger.info("Current positions snapshot", {
            totalPositions: positions.totalPositions,
            totalCapitalUsd: positions.totalCapitalUsd,
            totalInvestedUsd: positions.totalInvestedUsd,
            netPnlUsd: positions.netPnlUsd,
            positions: positions.positions.map(p => ({
                name: p.vaultName,
                amountUsd: p.amountUsd,
                roePct: p.roePct,
                pnlUsd: p.pnlUsd,
                isRecommended: recommendedSet.has(p.vaultAddress.toLowerCase()),
            })),
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

        // Build deposit time map for hold period enforcement
        const depositTimeMap = await buildLastDepositTimeMap();
        const now = Date.now();
        const minHoldMs = MIN_HOLD_DAYS * MS_PER_DAY;

        // Fetch market direction for stop-loss intelligence
        let marketDirection: "long" | "short" | "neutral" = "neutral";
        try {
            const marketData = await MarketDataService.getMarketOverlay();
            marketDirection = marketData.preferred_direction;
        } catch (err: any) {
            logger.warn("Failed to fetch market direction for stop-loss check", {
                error: err?.message,
            });
        }

        logger.info("Withdrawal scan starting", {
            positionCount: positions.positions.length,
            marketDirection,
            stopLossPct: STOP_LOSS_PCT,
            hardStopLossPct: HARD_STOP_LOSS_PCT,
            minHoldDays: MIN_HOLD_DAYS,
            depositTimeEntries: depositTimeMap.size,
        });

        // Full exit from non-recommended, inactive, and stop-loss vaults
        const withdrawals: VaultTransferAction[] = [];
        for (const position of positions.positions) {
            const address = position.vaultAddress.toLowerCase();
            const roePct = position.roePct ?? 0;
            const pnlUsd =
                typeof position.pnlUsd === "number" ? position.pnlUsd : null;

            // 1. HARD STOP-LOSS: Exit unconditionally at severe loss
            if (roePct <= HARD_STOP_LOSS_PCT) {
                logger.info("Hard stop-loss triggered", {
                    vaultAddress: position.vaultAddress,
                    vaultName: position.vaultName,
                    roePct,
                    threshold: HARD_STOP_LOSS_PCT,
                    pnlUsd,
                    reason: "hard-stop-loss",
                });
                const result = await RebalanceService.withdrawAllFromVault({
                    vaultAddress: position.vaultAddress as `0x${string}`,
                    dryRun,
                    includeLocked,
                    sweepDust: true,
                });
                withdrawals.push(result.action);
                continue;
            }

            // 2. SOFT STOP-LOSS: Exit at -15% if vault is NOT recommended OR not aligned with market
            if (roePct <= STOP_LOSS_PCT) {
                const isRecommended = recommendedSet.has(address);
                const vaultDirection = await getVaultNetDirection(position.vaultAddress);
                const isAligned = vaultDirection === marketDirection || marketDirection === "neutral";

                if (!isRecommended || !isAligned) {
                    logger.info("Stop-loss triggered (not recommended or mis-aligned)", {
                        vaultAddress: position.vaultAddress,
                        vaultName: position.vaultName,
                        roePct,
                        threshold: STOP_LOSS_PCT,
                        pnlUsd,
                        isRecommended,
                        vaultDirection,
                        marketDirection,
                        reason: "stop-loss",
                    });
                    const result = await RebalanceService.withdrawAllFromVault({
                        vaultAddress: position.vaultAddress as `0x${string}`,
                        dryRun,
                        includeLocked,
                        sweepDust: true,
                    });
                    withdrawals.push(result.action);
                    continue;
                }

                logger.info("Stop-loss threshold hit but vault is recommended and aligned — holding", {
                    vaultAddress: position.vaultAddress,
                    vaultName: position.vaultName,
                    roePct,
                    vaultDirection,
                    marketDirection,
                });
            }

            // 3. INACTIVE VAULT EXIT: Withdraw from vaults with 0 positions + 0 trades in 7d
            const isInactive = await checkVaultInactive(position.vaultAddress);

            if (isInactive) {
                logger.info("Withdrawing from inactive vault (0 positions, no recent trades)", {
                    vaultAddress: position.vaultAddress,
                    vaultName: position.vaultName,
                    pnlUsd,
                    inRecommendations: recommendedSet.has(address),
                    reason: "inactive-vault",
                });
                const result = await RebalanceService.withdrawAllFromVault({
                    vaultAddress: position.vaultAddress as `0x${string}`,
                    dryRun,
                    includeLocked,
                    sweepDust: true,
                });
                withdrawals.push(result.action);
                continue;
            }

            // 4. Skip if still in recommendations (handled by TP strategy above)
            if (recommendedSet.has(address)) {
                continue;
            }

            // 5. HOLD PERIOD: Don't rotate out of recently entered vaults (unless stop-loss, handled above)
            const lastDeposit = depositTimeMap.get(address);
            if (lastDeposit && (now - lastDeposit) < minHoldMs) {
                const holdDaysRemaining = ((minHoldMs - (now - lastDeposit)) / MS_PER_DAY).toFixed(1);
                logger.info("Skipping exit (minimum hold period not met)", {
                    vaultAddress: position.vaultAddress,
                    vaultName: position.vaultName,
                    roePct,
                    daysSinceDeposit: ((now - lastDeposit) / MS_PER_DAY).toFixed(1),
                    minHoldDays: MIN_HOLD_DAYS,
                    holdDaysRemaining,
                    reason: "hold-period",
                });
                continue;
            }

            // 6. EXIT NON-RECOMMENDED: Vault is not recommended and hold period is met — exit
            logger.info("Exiting non-recommended vault", {
                vaultAddress: position.vaultAddress,
                vaultName: position.vaultName,
                roePct,
                pnlUsd,
                reason: "not-recommended",
            });
            const result = await RebalanceService.withdrawAllFromVault({
                vaultAddress: position.vaultAddress as `0x${string}`,
                dryRun,
                includeLocked,
                sweepDust: true,
            });
            withdrawals.push(result.action);
        }

        const hasSubmittedWithdrawals =
            withdrawals.some((action) => action.status === "submitted") ||
            tpWithdrawals.some((action) => action.status === "submitted");

        if (withdrawalDelayMs > 0 && hasSubmittedWithdrawals) {
            logger.info("Waiting for withdrawals to settle", {
                withdrawalDelayMs,
            });
            await sleep(withdrawalDelayMs);
        }

        // Rebuild deposit plan after withdrawals to pick up freed slots
        const depositPlan = hasSubmittedWithdrawals
            ? await DepositService.buildDepositPlan({
                  refreshCandidates: false,
                  refreshRecommendations: false,
                  maxActive: 10,
              })
            : plan;

        if (hasSubmittedWithdrawals) {
            logger.info("Rebuilt deposit plan after withdrawals", {
                previousTargets: plan.targets.length,
                newTargets: depositPlan.targets.length,
            });
        }

        const deposits = await DepositService.executeDepositPlan(depositPlan, {
            dryRun,
            minDepositUsd,
        });

        // Categorize withdrawal reasons for analysis
        const withdrawalsByReason: Record<string, number> = {};
        for (const w of withdrawals) {
            const reason = w.reason ?? "unknown";
            withdrawalsByReason[reason] = (withdrawalsByReason[reason] ?? 0) + 1;
        }

        logger.info("Rebalance round completed", {
            startedAt,
            durationMs: Date.now() - new Date(startedAt).getTime(),
            dryRun,
            marketDirection,
            summary: {
                tpWithdrawals: tpWithdrawals.length,
                tpSubmitted: tpWithdrawals.filter(a => a.status === "submitted").length,
                withdrawals: withdrawals.length,
                withdrawalsSubmitted: withdrawals.filter(a => a.status === "submitted").length,
                withdrawalsByReason,
                depositsTotal: deposits.total,
                depositsSubmitted: deposits.submitted,
                depositsSkipped: deposits.skipped,
                depositsErrors: deposits.errors,
            },
            recommended: recommendedSet.size,
            positionsAfter: positions.totalPositions,
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

async function checkVaultInactive(vaultAddress: string): Promise<boolean> {
    try {
        // Check current positions
        const accountSummary = await HyperliquidConnector.getVaultAccountSummary(vaultAddress);
        const currentPositions = Array.isArray(accountSummary?.assetPositions)
            ? accountSummary.assetPositions.length
            : 0;

        if (currentPositions > 0) {
            return false;
        }

        // Check trades in last 7 days
        await sleep(200); // Rate limiting
        const tradesLast7d = await HyperliquidConnector.getVaultTradesCount(vaultAddress, 7);

        if (tradesLast7d === null || tradesLast7d > 0) {
            return false;
        }

        // Vault has 0 positions and 0 trades in last 7 days
        return true;
    } catch (error: any) {
        logger.warn("Failed to check vault activity", {
            vaultAddress,
            error: error?.message,
        });
        // If we can't check, assume it's active (don't withdraw on error)
        return false;
    }
}

async function getVaultNetDirection(vaultAddress: string): Promise<"long" | "short" | "neutral"> {
    try {
        const summary = await HyperliquidConnector.getVaultAccountSummary(vaultAddress);
        if (!summary || !Array.isArray(summary.assetPositions) || summary.assetPositions.length === 0) {
            return "neutral";
        }
        let netExposure = 0;
        let grossExposure = 0;
        for (const entry of summary.assetPositions) {
            const pos = entry?.position;
            if (!pos) continue;
            const szi = Number(pos.szi);
            const value = Math.abs(Number(pos.positionValue ?? 0));
            if (!Number.isFinite(szi) || !Number.isFinite(value)) continue;
            netExposure += szi >= 0 ? value : -value;
            grossExposure += value;
        }
        if (grossExposure === 0) return "neutral";
        const netRatio = netExposure / grossExposure;
        if (netRatio > 0.2) return "long";
        if (netRatio < -0.2) return "short";
        return "neutral";
    } catch (error: any) {
        logger.warn("Failed to get vault net direction", {
            vaultAddress,
            error: error?.message,
        });
        return "neutral";
    }
}

async function buildLastDepositTimeMap(): Promise<Map<string, number>> {
    const wallet = process.env.WALLET as `0x${string}` | undefined;
    if (!wallet) return new Map();
    try {
        const updates = await HyperliquidConnector.getUserVaultLedgerUpdates(wallet);
        const map = new Map<string, number>();
        for (const update of updates) {
            if (update.type !== "vaultDeposit") continue;
            if (!Number.isFinite(update.time)) continue;
            const addr = update.vault.toLowerCase();
            const existing = map.get(addr);
            if (!existing || update.time > existing) {
                map.set(addr, update.time);
            }
        }
        return map;
    } catch (error: any) {
        logger.warn("Failed to build deposit time map", { error: error?.message });
        return new Map();
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
