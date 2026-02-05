import { logger } from "../utils/logger";
import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import { VaultService } from "../vaults/VaultService";
import type {
    RecommendationSet,
    SuggestedAllocations,
    VaultRecommendation,
} from "../vaults/types";
import { RebalanceService, type VaultTransferAction } from "./RebalanceService";

export type DepositPlanOptions = {
    refreshRecommendations?: boolean;
    refreshCandidates?: boolean;
    maxActive?: number;
    highCount?: number;
    lowCount?: number;
    highTotalPct?: number;
    lowTotalPct?: number;
};

export type DepositTarget = {
    vaultAddress: `0x${string}`;
    name: string;
    confidence: "high" | "low";
    targetPct: number;
    targetUsd: number;
    currentUsd: number;
    desiredUsd: number;
    depositUsd: number;
};

export type DepositPlan = {
    generatedAt: string;
    source: RecommendationSet["source"];
    model?: string;
    sourceWalletAddress: `0x${string}`;
    totalCapitalUsd: number;
    availableBalanceUsd: number;
    currentInvestedUsd: number;
    allocation: {
        maxActive: number;
        highCount: number;
        lowCount: number;
        highTotalPct: number;
        lowTotalPct: number;
    };
    suggestedAllocations?: SuggestedAllocations;
    recommendations: RecommendationSet;
    targets: DepositTarget[];
};

export type ExecuteDepositPlanOptions = {
    dryRun?: boolean;
    minDepositUsd?: number;
};

export type ExecuteDepositPlanResult = {
    sourceWalletAddress: `0x${string}`;
    dryRun: boolean;
    total: number;
    submitted: number;
    skipped: number;
    errors: number;
    actions: VaultTransferAction[];
};

const DEFAULT_MAX_ACTIVE = readNumberEnv(process.env.DEPOSIT_ACTIVE_COUNT, 10);
const DEFAULT_HIGH_COUNT = readNumberEnv(process.env.DEPOSIT_HIGH_COUNT, 7);
const DEFAULT_LOW_COUNT = readNumberEnv(process.env.DEPOSIT_LOW_COUNT, 3);
const DEFAULT_HIGH_PCT = readNumberEnv(process.env.DEPOSIT_HIGH_PCT, 80);
const DEFAULT_LOW_PCT = readNumberEnv(process.env.DEPOSIT_LOW_PCT, 20);

export class DepositService {
    static async buildDepositPlan(
        options: DepositPlanOptions = {}
    ): Promise<DepositPlan> {
        const sourceWalletAddress = (process.env.WALLET as `0x${string}`) as `0x${string}`;
        if (!sourceWalletAddress) {
            throw new Error("WALLET is not set");
        }

        const maxActive = clampCount(
            options.maxActive ?? DEFAULT_MAX_ACTIVE,
            1
        );
        const highCount = clampCount(
            options.highCount ?? DEFAULT_HIGH_COUNT,
            0,
            maxActive
        );
        const lowCount = clampCount(
            options.lowCount ?? DEFAULT_LOW_COUNT,
            0,
            maxActive - highCount
        );
        const rawHighPct = options.highTotalPct ?? DEFAULT_HIGH_PCT;
        const rawLowPct = options.lowTotalPct ?? DEFAULT_LOW_PCT;

        const recommendations = await VaultService.getRecommendations({
            refresh: options.refreshRecommendations,
            refreshCandidates: options.refreshCandidates,
        });

        const highSelected = recommendations.highConfidence.slice(0, highCount);
        const lowSelected = recommendations.lowConfidence.slice(0, lowCount);

        const actualHighCount = highSelected.length;
        const actualLowCount = lowSelected.length;
        const { highPct, lowPct } = normalizeGroupPcts(
            rawHighPct,
            rawLowPct,
            actualHighCount,
            actualLowCount
        );
        const hints = recommendations.suggestedAllocations;
        const groupHighPct =
            hints && Number.isFinite(Number(hints.highPct))
                ? hints.highPct
                : highPct;
        const groupLowPct =
            hints && Number.isFinite(Number(hints.lowPct))
                ? hints.lowPct
                : lowPct;

        // Get actual perps wallet balance (available for deposits)
        const perpsBalanceUsd =
            (await HyperliquidConnector.getUserPerpsBalance(sourceWalletAddress)) ?? 0;
        const currentEquities =
            await HyperliquidConnector.getUserVaultEquities(sourceWalletAddress);

        // Filter out dust positions (< $1) when counting active vaults
        const DUST_THRESHOLD_USD = 1;
        const significantEquities = currentEquities.filter(
            (entry) => entry.equity >= DUST_THRESHOLD_USD
        );
        const currentEquityMap = new Map(
            significantEquities.map((entry) => [
                entry.vaultAddress.toLowerCase(),
                entry.equity,
            ])
        );
        const currentVaultCount = significantEquities.length;
        const currentInvestedUsd = significantEquities.reduce(
            (sum, entry) => sum + (Number.isFinite(entry.equity) ? entry.equity : 0),
            0
        );
        const totalCapitalUsd = perpsBalanceUsd + currentInvestedUsd;

        logger.info("Current vault exposure", {
            currentVaultCount,
            maxActive,
            availableSlots: Math.max(0, maxActive - currentVaultCount),
            dustPositionsFiltered: currentEquities.length - significantEquities.length,
        });

        // Filter out vaults we already have exposure to (avoid concentration risk)
        // Then sort by score (descending) to prioritize highest confidence vaults
        const highWithoutExposure = highSelected
            .filter((rec) => !currentEquityMap.has(rec.vaultAddress.toLowerCase()))
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const lowWithoutExposure = lowSelected
            .filter((rec) => !currentEquityMap.has(rec.vaultAddress.toLowerCase()))
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

        // Limit new deposits to not exceed maxActive total vaults
        const availableSlots = Math.max(0, maxActive - currentVaultCount);
        if (availableSlots === 0) {
            logger.info("Already at max vault count, skipping new deposits", {
                currentVaultCount,
                maxActive,
            });
        }

        const skippedCount =
            (highSelected.length - highWithoutExposure.length) +
            (lowSelected.length - lowWithoutExposure.length);
        if (skippedCount > 0) {
            logger.info("Skipping vaults with existing exposure", {
                skippedCount,
                highSkipped: highSelected.length - highWithoutExposure.length,
                lowSkipped: lowSelected.length - lowWithoutExposure.length,
            });
        }

        // Limit to available slots to not exceed maxActive vaults
        // Prioritize high confidence vaults first
        const highSlotsToUse = Math.min(highWithoutExposure.length, availableSlots);
        const remainingSlots = availableSlots - highSlotsToUse;
        const lowSlotsToUse = Math.min(lowWithoutExposure.length, remainingSlots);

        const limitedHighWithoutExposure = highWithoutExposure.slice(0, highSlotsToUse);
        const limitedLowWithoutExposure = lowWithoutExposure.slice(0, lowSlotsToUse);

        if (highWithoutExposure.length > highSlotsToUse || lowWithoutExposure.length > lowSlotsToUse) {
            logger.info("Limiting new deposits to available slots (sorted by score)", {
                availableSlots,
                highRequested: highWithoutExposure.length,
                highUsed: highSlotsToUse,
                lowRequested: lowWithoutExposure.length,
                lowUsed: lowSlotsToUse,
                selectedHighVaults: highWithoutExposure.slice(0, highSlotsToUse).map(v => ({
                    name: v.name,
                    score: v.score,
                })),
                selectedLowVaults: lowWithoutExposure.slice(0, lowSlotsToUse).map(v => ({
                    name: v.name,
                    score: v.score,
                })),
            });
        }

        const filteredHighCount = limitedHighWithoutExposure.length;
        const filteredLowCount = limitedLowWithoutExposure.length;

        // Calculate barbell-weighted target per vault based on FULL recommendation counts
        // High confidence vaults get a larger share than low confidence vaults
        const totalHighCount = recommendations.highConfidence.length;
        const totalLowCount = recommendations.lowConfidence.length;

        // Calculate per-vault targets using barbell weighting
        // E.g., with 5 high / 5 low and 70/30 split:
        //   High target: 70% / 5 = 14% each
        //   Low target: 30% / 5 = 6% each
        const highTargetPerVault = totalHighCount > 0
            ? totalCapitalUsd * (groupHighPct / 100) / totalHighCount
            : 0;
        const lowTargetPerVault = totalLowCount > 0
            ? totalCapitalUsd * (groupLowPct / 100) / totalLowCount
            : 0;

        // Calculate total allocation needed for new vaults based on their confidence levels
        const highAllocationNeeded = highTargetPerVault * filteredHighCount;
        const lowAllocationNeeded = lowTargetPerVault * filteredLowCount;
        const totalAllocationNeeded = highAllocationNeeded + lowAllocationNeeded;

        // Cap at available balance
        const availableForDeposit = Math.min(perpsBalanceUsd, totalAllocationNeeded);

        // Scale down proportionally if we don't have enough balance
        const scaleFactor = totalAllocationNeeded > 0
            ? availableForDeposit / totalAllocationNeeded
            : 0;

        const adjustedHighAllocation = highAllocationNeeded * scaleFactor;
        const adjustedLowAllocation = lowAllocationNeeded * scaleFactor;

        logger.info("Barbell allocation calculated", {
            totalCapitalUsd,
            barbellSplit: { highPct: groupHighPct, lowPct: groupLowPct },
            recommendationCounts: { high: totalHighCount, low: totalLowCount },
            targetPerVault: {
                high: roundUsd(highTargetPerVault),
                low: roundUsd(lowTargetPerVault),
            },
            newVaultCounts: { high: filteredHighCount, low: filteredLowCount },
            allocationNeeded: roundUsd(totalAllocationNeeded),
            perpsBalanceUsd,
            availableForDeposit: roundUsd(availableForDeposit),
            scaleFactor: roundPct(scaleFactor * 100) + "%",
        });

        const targets: DepositTarget[] = [
            ...limitedHighWithoutExposure.map((rec) =>
                buildTargetFromAllocation(
                    rec,
                    "high",
                    adjustedHighAllocation,
                    filteredHighCount
                )
            ),
            ...limitedLowWithoutExposure.map((rec) =>
                buildTargetFromAllocation(
                    rec,
                    "low",
                    adjustedLowAllocation,
                    filteredLowCount
                )
            ),
        ];

        logger.info("Deposit allocation calculated", {
            availableForDeposit,
            highGroupAllocation: adjustedHighAllocation,
            lowGroupAllocation: adjustedLowAllocation,
            highVaults: filteredHighCount,
            lowVaults: filteredLowCount,
        });

        const planned = targets;

        const planSummaryTargets = planned.map((target) => ({
            vaultAddress: target.vaultAddress,
            depositUsd: target.depositUsd,
            targetPct: target.targetPct,
        }));
        logger.info("Deposit plan ready", {
            sourceWalletAddress,
            totalCapitalUsd,
            availableBalanceUsd: perpsBalanceUsd,
            targetCount: planned.length,
            suggestedAllocations: recommendations.suggestedAllocations,
            targets: planSummaryTargets,
        });

        return {
            generatedAt: new Date().toISOString(),
            source: recommendations.source,
            model: recommendations.model,
            sourceWalletAddress,
            totalCapitalUsd,
            availableBalanceUsd: perpsBalanceUsd,
            currentInvestedUsd,
            allocation: {
                maxActive,
                highCount: actualHighCount,
                lowCount: actualLowCount,
                highTotalPct: highPct,
                lowTotalPct: lowPct,
            },
            suggestedAllocations: recommendations.suggestedAllocations,
            recommendations,
            targets: planned,
        };
    }

    static async executeDepositPlan(
        plan: DepositPlan,
        options: ExecuteDepositPlanOptions = {}
    ): Promise<ExecuteDepositPlanResult> {
        const dryRun = options.dryRun ?? true;
        const minDepositUsd = Math.max(0, options.minDepositUsd ?? 5);

        let submitted = 0;
        let skipped = 0;
        let errors = 0;
        const actions: VaultTransferAction[] = [];

        for (const target of plan.targets) {
            if (target.depositUsd < minDepositUsd) {
                skipped += 1;
                logger.info("Skipping deposit (below minimum)", {
                    vaultAddress: target.vaultAddress,
                    depositUsd: target.depositUsd,
                    minDepositUsd,
                });
                actions.push({
                    vaultAddress: target.vaultAddress,
                    usdMicros: Math.floor(target.depositUsd * 1e6),
                    status: "skipped",
                    reason: "below-minimum",
                });
                continue;
            }
            const result = await RebalanceService.depositToVault({
                vaultAddress: target.vaultAddress,
                amountUsd: target.depositUsd,
                dryRun,
            });
            actions.push(result.action);
            if (result.action.status === "submitted") submitted += 1;
            if (result.action.status === "skipped") skipped += 1;
            if (result.action.status === "error") {
                errors += 1;
                logger.warn("Deposit failed, continuing with remaining deposits", {
                    vaultAddress: target.vaultAddress,
                    error: result.action.error,
                    remainingTargets: plan.targets.length - actions.length,
                });
            }
        }

        return {
            sourceWalletAddress: plan.sourceWalletAddress,
            dryRun,
            total: plan.targets.length,
            submitted,
            skipped,
            errors,
            actions,
        };
    }
}

function buildTargetFromAllocation(
    rec: VaultRecommendation,
    confidence: "high" | "low",
    groupAllocationUsd: number,
    groupCount: number
): DepositTarget {
    // Split group allocation evenly among vaults in this group
    // Note: AI's allocationPct is for total portfolio, not applicable here since
    // we've already filtered to specific vaults based on available slots
    const perVaultUsd = groupCount > 0
        ? groupAllocationUsd / groupCount
        : 0;
    const depositUsd = roundUsd(perVaultUsd);
    const targetPct = groupCount > 0 ? 100 / groupCount : 0;

    return {
        vaultAddress: rec.vaultAddress as `0x${string}`,
        name: rec.name,
        confidence,
        targetPct,
        targetUsd: depositUsd,
        currentUsd: 0, // No existing exposure (filtered out earlier)
        desiredUsd: depositUsd,
        depositUsd,
    };
}

function normalizeGroupPcts(
    highPct: number,
    lowPct: number,
    highCount: number,
    lowCount: number
): { highPct: number; lowPct: number } {
    if (highCount === 0 && lowCount === 0) {
        return { highPct: 0, lowPct: 0 };
    }
    if (highCount === 0) {
        return { highPct: 0, lowPct: 100 };
    }
    if (lowCount === 0) {
        return { highPct: 100, lowPct: 0 };
    }
    const total = Number(highPct) + Number(lowPct);
    if (!Number.isFinite(total) || total <= 0) {
        return { highPct: 70, lowPct: 30 };
    }
    const scale = 100 / total;
    return {
        highPct: roundPct(Number(highPct) * scale),
        lowPct: roundPct(Number(lowPct) * scale),
    };
}

function clampCount(value: number, min: number, max?: number): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return min;
    const upper = max ?? Number.POSITIVE_INFINITY;
    return Math.min(upper, Math.max(min, Math.floor(num)));
}

function readNumberEnv(value: any, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function roundPct(value: number): number {
    return Math.round(value * 100) / 100;
}

function roundUsd(value: number): number {
    return Math.round(value * 100) / 100;
}
