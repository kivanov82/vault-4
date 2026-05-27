import { logger } from "../utils/logger";
import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import { VaultService } from "../vaults/VaultService";
import { VaultContractService } from "../settlement/VaultContractService";
import type {
    RecommendationSet,
    SuggestedAllocations,
    VaultRecommendation,
} from "../vaults/types";
import { RebalanceService, type VaultTransferAction } from "./RebalanceService";
import { TraceService } from "../../db/TraceService";
import { computeTopupTargets } from "./topup";
import {
    buildTargetFromAllocation,
    clampCount,
    floorUsd,
    normalizeGroupPcts,
    roundPct,
    roundUsd,
} from "./depositMath";
import type { DepositTarget } from "./DepositService.types";
export type { DepositTarget } from "./DepositService.types";

export type DepositPlanOptions = {
    refreshRecommendations?: boolean;
    refreshCandidates?: boolean;
    maxActive?: number;
    highCount?: number;
    lowCount?: number;
    highTotalPct?: number;
    lowTotalPct?: number;
    /**
     * If provided, skip the (expensive) Claude ranking call and reuse this set.
     * Used by the rebalance rebuild pass after withdrawals settle.
     */
    recommendations?: RecommendationSet;
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
    roundId?: number | null;
    platformTvlUsd?: number | null;
    marketDirection?: "long" | "short" | "neutral";
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

const DEFAULT_MAX_ACTIVE = 10;
const DEFAULT_HIGH_COUNT = 7;
const DEFAULT_LOW_COUNT = 3;
const DEFAULT_HIGH_PCT = 80;
const DEFAULT_LOW_PCT = 20;
// Max percentage of the post-deposit portfolio (existing + new) that can share the
// same directional bias (long or short). Neutrals don't count toward either side.
const MAX_SAME_DIRECTION_PCT = 60;
// When true, the deposit pass also tops up held vaults whose currentUsd is
// below Claude's per-vault target (totalCapital × allocationPct / 100).
// On by default — fresh investor capital otherwise sits idle in the perps
// wallet when all 10 vault slots are already filled. New slots always take
// priority over top-ups when the perps budget is tight. Set
// REBALANCE_TOPUP_ENABLED=false to revert to new-slots-only behaviour.
const TOPUP_ENABLED =
    (process.env.REBALANCE_TOPUP_ENABLED ?? "true").toLowerCase() === "true";
// Skip top-ups smaller than max($5, currentUsd × tolerance/100). Default 30%
// means a held position needs to be ≥30% underweight (or under-by-$5,
// whichever is larger) before a top-up fires — keeps the system from
// chasing every 1-2% allocation drift between rounds.
const TOPUP_TOLERANCE_PCT = readNumberEnv(
    process.env.REBALANCE_TOPUP_TOLERANCE_PCT,
    30
);
const MIN_DEPOSIT_USD = 5;

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

        logger.info("Building deposit plan", {
            maxActive,
            highCount,
            lowCount,
            highPct: rawHighPct,
            lowPct: rawLowPct,
            maxSameDirectionPct: MAX_SAME_DIRECTION_PCT,
            refreshRecommendations: options.refreshRecommendations,
            refreshCandidates: options.refreshCandidates,
        });

        const recommendations =
            options.recommendations ??
            (await VaultService.getRecommendations({
                refresh: options.refreshRecommendations,
                refreshCandidates: options.refreshCandidates,
            }));
        if (options.recommendations) {
            logger.info("Reusing supplied recommendation set (skipping Claude ranking)", {
                source: recommendations.source,
                model: recommendations.model,
                highCount: recommendations.highConfidence.length,
                lowCount: recommendations.lowConfidence.length,
            });
        }

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

        const slotLimitedHigh = highWithoutExposure.slice(0, highSlotsToUse);
        const slotLimitedLow = lowWithoutExposure.slice(0, lowSlotsToUse);

        if (highWithoutExposure.length > highSlotsToUse || lowWithoutExposure.length > lowSlotsToUse) {
            logger.info("Limiting new deposits to available slots (sorted by score)", {
                availableSlots,
                highRequested: highWithoutExposure.length,
                highUsed: highSlotsToUse,
                lowRequested: lowWithoutExposure.length,
                lowUsed: lowSlotsToUse,
                selectedHighVaults: slotLimitedHigh.map(v => ({
                    name: v.name,
                    score: v.score,
                })),
                selectedLowVaults: slotLimitedLow.map(v => ({
                    name: v.name,
                    score: v.score,
                })),
            });
        }

        // Seed the directional counters with current holdings so we can't pile more
        // longs on top of an already-long book.
        const allCandidates = [
            ...slotLimitedHigh.map(v => ({ ...v, group: "high" as const })),
            ...slotLimitedLow.map(v => ({ ...v, group: "low" as const })),
        ];
        const existingAddresses = significantEquities.map(e => e.vaultAddress.toLowerCase());
        const [existingDirectionMap, directionMap] = await Promise.all([
            classifyVaultDirections(existingAddresses),
            classifyVaultDirections(allCandidates.map(c => c.vaultAddress)),
        ]);

        const directionCounts: Record<DirectionalBias, number> = { long: 0, short: 0 };
        for (const dir of existingDirectionMap.values()) {
            if (dir !== "neutral") directionCounts[dir]++;
        }
        const existingLong = directionCounts.long;
        const existingShort = directionCounts.short;

        const totalPortfolioCount = existingAddresses.length + allCandidates.length;
        const maxSameDirection = Math.ceil(totalPortfolioCount * (MAX_SAME_DIRECTION_PCT / 100));
        const accepted = new Set<string>();

        for (const candidate of allCandidates) {
            const dir = directionMap.get(candidate.vaultAddress.toLowerCase()) ?? "neutral";
            if (dir === "neutral") {
                accepted.add(candidate.vaultAddress.toLowerCase());
                continue;
            }
            if (directionCounts[dir] >= maxSameDirection) {
                logger.info("Skipping vault (directional concentration limit)", {
                    vaultAddress: candidate.vaultAddress,
                    vaultName: candidate.name,
                    direction: dir,
                    currentCount: directionCounts[dir],
                    maxSameDirection,
                    existingCount: dir === "long" ? existingLong : existingShort,
                });
                continue;
            }
            directionCounts[dir]++;
            accepted.add(candidate.vaultAddress.toLowerCase());
        }

        const limitedHighWithoutExposure = slotLimitedHigh.filter(
            v => accepted.has(v.vaultAddress.toLowerCase())
        );
        const limitedLowWithoutExposure = slotLimitedLow.filter(
            v => accepted.has(v.vaultAddress.toLowerCase())
        );

        if (accepted.size < allCandidates.length) {
            logger.info("Directional concentration filter applied", {
                before: allCandidates.length,
                after: accepted.size,
                existingDirectionCounts: { long: existingLong, short: existingShort },
                postDepositDirectionCounts: directionCounts,
                maxSameDirection,
                totalPortfolioCount,
            });
        }

        const filteredHighCount = limitedHighWithoutExposure.length;
        const filteredLowCount = limitedLowWithoutExposure.length;

        // Combined list of vaults we'll actually deposit into, in priority order.
        const allFiltered: { rec: VaultRecommendation; confidence: "high" | "low" }[] = [
            ...limitedHighWithoutExposure.map((rec) => ({ rec, confidence: "high" as const })),
            ...limitedLowWithoutExposure.map((rec) => ({ rec, confidence: "low" as const })),
        ];

        // Prefer Claude's per-vault allocations when available. These come from
        // suggestedAllocations and get populated on each VaultRecommendation via
        // mapOpenAiRanking. Sum across the FILTERED subset (some recommended vaults
        // may be skipped for existing exposure or directional limits).
        const filteredAllocSum = allFiltered.reduce(
            (sum, { rec }) => sum + Math.max(0, Number(rec.allocationPct) || 0),
            0
        );
        const useClaudeWeights = filteredAllocSum > 0;

        // Fallback even-split targets (used when Claude did not provide allocations,
        // e.g. heuristic source or parsing failed).
        const totalHighCount = recommendations.highConfidence.length;
        const totalLowCount = recommendations.lowConfidence.length;
        const highTargetPerVault = totalHighCount > 0
            ? totalCapitalUsd * (groupHighPct / 100) / totalHighCount
            : 0;
        const lowTargetPerVault = totalLowCount > 0
            ? totalCapitalUsd * (groupLowPct / 100) / totalLowCount
            : 0;
        const highAllocationNeeded = highTargetPerVault * filteredHighCount;
        const lowAllocationNeeded = lowTargetPerVault * filteredLowCount;

        // Total USD we want to deploy into the filtered set.
        const totalAllocationNeeded = useClaudeWeights
            ? totalCapitalUsd * (filteredAllocSum / 100)
            : highAllocationNeeded + lowAllocationNeeded;

        // Reserve funds for pending contract withdrawals
        let withdrawReserveUsd = 0;
        try {
            const contractState = await VaultContractService.getContractState();
            if (contractState.pendingWithdraws > 0) {
                withdrawReserveUsd = contractState.pendingWithdraws * contractState.sharePrice;
                logger.info("Reserving funds for pending withdrawals", {
                    pendingWithdrawShares: contractState.pendingWithdraws,
                    sharePrice: contractState.sharePrice,
                    withdrawReserveUsd: roundUsd(withdrawReserveUsd),
                });
            }
        } catch (err: any) {
            logger.warn("Could not read contract state for withdraw reserve", {
                message: err?.message,
            });
        }

        // Cap at available balance minus withdrawal reserve
        const availableForDeposit = Math.min(
            Math.max(0, perpsBalanceUsd - withdrawReserveUsd),
            totalAllocationNeeded
        );

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
            allocationSource: useClaudeWeights ? "claude" : "even-split",
            filteredAllocSum: useClaudeWeights ? roundPct(filteredAllocSum) : undefined,
        });

        const targets: DepositTarget[] = useClaudeWeights
            ? allFiltered.map(({ rec, confidence }) => {
                  const pct = Math.max(0, Number(rec.allocationPct) || 0);
                  const perVaultUsd = availableForDeposit * (pct / filteredAllocSum);
                  const depositUsd = floorUsd(perVaultUsd);
                  return {
                      vaultAddress: rec.vaultAddress as `0x${string}`,
                      name: rec.name,
                      confidence,
                      kind: "new" as const,
                      targetPct: roundPct((pct / filteredAllocSum) * 100),
                      targetUsd: depositUsd,
                      currentUsd: 0,
                      desiredUsd: depositUsd,
                      depositUsd,
                  };
              })
            : [
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

        // ── Top-up pass (off by default) ───────────────────────────────────
        // For each Claude-recommended vault we *already* hold, compute the
        // delta between Claude's per-vault target ($ at totalCapital × pct)
        // and our current holding. New slots have priority — top-ups eat
        // whatever new-slot deposits leave behind in the perps wallet.
        if (TOPUP_ENABLED) {
            const newSlotConsumed = targets.reduce(
                (sum, t) => sum + (Number.isFinite(t.depositUsd) ? t.depositUsd : 0),
                0
            );
            const topupResult = computeTopupTargets({
                highSelected,
                lowSelected,
                currentEquityMap,
                totalCapitalUsd,
                perpsBalanceUsd,
                withdrawReserveUsd,
                newSlotConsumed,
                tolerancePct: TOPUP_TOLERANCE_PCT,
                minDepositUsd: MIN_DEPOSIT_USD,
            });
            targets.push(...topupResult.targets);
            logger.info("Top-up pass evaluated", {
                enabled: true,
                tolerancePct: TOPUP_TOLERANCE_PCT,
                heldRecsCount: topupResult.diagnostics.heldRecsCount,
                eligibleCount: topupResult.diagnostics.eligibleCount,
                skippedBelowTolerance:
                    topupResult.diagnostics.skippedBelowTolerance.length,
                remainingBudget: topupResult.diagnostics.remainingBudget,
                totalWant: topupResult.diagnostics.totalWant,
                scaleFactor:
                    roundPct(topupResult.diagnostics.scaleFactor * 100) + "%",
                topupsQueued: topupResult.targets.length,
                topupsTotalUsd: roundUsd(
                    topupResult.targets.reduce((s, t) => s + t.depositUsd, 0)
                ),
                skipped: topupResult.diagnostics.skippedBelowTolerance,
            });
        }

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
        const roundId = options.roundId ?? null;
        const platformTvlUsd = options.platformTvlUsd ?? null;
        const marketDirection = options.marketDirection ?? "neutral";

        let submitted = 0;
        let skipped = 0;
        let errors = 0;
        const actions: VaultTransferAction[] = [];

        logger.info("Executing deposit plan", {
            dryRun,
            minDepositUsd,
            targetCount: plan.targets.length,
            totalDepositUsd: plan.targets.reduce((s, t) => s + t.depositUsd, 0),
            targets: plan.targets.map(t => ({
                name: t.name,
                kind: t.kind,
                confidence: t.confidence,
                depositUsd: t.depositUsd,
            })),
        });

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
            if (result.action.status === "submitted") {
                submitted += 1;
                logger.info("Deposit submitted", {
                    vaultAddress: target.vaultAddress,
                    vaultName: target.name,
                    kind: target.kind,
                    depositUsd: target.depositUsd,
                    confidence: target.confidence,
                    dryRun,
                });
            }
            if (result.action.status === "skipped") skipped += 1;
            if (result.action.status === "error") {
                errors += 1;
                logger.warn("Deposit failed, continuing with remaining deposits", {
                    vaultAddress: target.vaultAddress,
                    error: result.action.error,
                    remainingTargets: plan.targets.length - actions.length,
                });
            }

            if (roundId) {
                const snapshotId = await TraceService.recordVaultSnapshot(roundId, {
                    vaultAddress: target.vaultAddress,
                    vaultName: target.name,
                    assumedBias: marketDirection,
                });
                const succeeded = result.action.status === "submitted";
                const isTopup = target.kind === "topup";
                await TraceService.recordPositionEvent({
                    roundId,
                    vaultAddress: target.vaultAddress,
                    vaultSnapshotId: snapshotId,
                    action: isTopup ? "topup" : "deposit",
                    amountUsd: succeeded ? target.depositUsd : 0,
                    preEquityUsd: target.currentUsd,
                    targetEquityUsd: target.targetUsd,
                    confidence: target.confidence,
                    reasonText: isTopup
                        ? `topup confidence=${target.confidence} delta=${target.depositUsd} (target=${target.targetUsd}, current=${target.currentUsd})`
                        : `deposit confidence=${target.confidence}`,
                    txMeta: result.action,
                    succeeded,
                    hlPnlUsd: null,
                    platformTvlUsd,
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

function readNumberEnv(value: any, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

type VaultDirection = "long" | "short" | "neutral";
type DirectionalBias = Exclude<VaultDirection, "neutral">;

async function classifyVaultDirections(
    vaultAddresses: string[]
): Promise<Map<string, VaultDirection>> {
    const result = new Map<string, VaultDirection>();
    for (const addr of vaultAddresses) {
        try {
            const summary = await HyperliquidConnector.getVaultAccountSummary(addr);
            if (!summary || !Array.isArray(summary.assetPositions) || summary.assetPositions.length === 0) {
                result.set(addr.toLowerCase(), "neutral");
                continue;
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
            if (grossExposure === 0) {
                result.set(addr.toLowerCase(), "neutral");
                continue;
            }
            const netRatio = netExposure / grossExposure;
            if (netRatio > 0.2) result.set(addr.toLowerCase(), "long");
            else if (netRatio < -0.2) result.set(addr.toLowerCase(), "short");
            else result.set(addr.toLowerCase(), "neutral");
        } catch (error: any) {
            logger.warn("Failed to classify vault direction", {
                vaultAddress: addr,
                error: error?.message,
            });
            result.set(addr.toLowerCase(), "neutral");
        }
    }
    return result;
}
