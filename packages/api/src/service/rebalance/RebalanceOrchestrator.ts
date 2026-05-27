import { DepositService } from "./DepositService";
import { RebalanceService, type VaultTransferAction } from "./RebalanceService";
import { VaultService } from "../vaults/VaultService";
import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import { MarketDataService } from "../claude/MarketDataService";
import { logger } from "../utils/logger";
import { TraceService } from "../../db/TraceService";
import type { PositionEventAction } from "../../db/types";
import type { UserPosition } from "../vaults/types";

const STOP_LOSS_PCT = -15;
const HARD_STOP_LOSS_PCT = -25;
const MIN_HOLD_DAYS = 5;
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

const DEFAULT_WITHDRAWAL_DELAY_MS = 60000;

export class RebalanceOrchestrator {
    /**
     * Latest Claude-sourced recommendation set, updated each rebalance round.
     * Read by /api/strategy/premium so paid clients can see top picks without
     * triggering a fresh Claude run on the request path.
     */
    private static latestRecommendations: Awaited<ReturnType<typeof VaultService.getRecommendations>> | null = null;
    private static latestRecommendationsAt: string | null = null;

    static getLatestRecommendations() {
        if (!this.latestRecommendations) return null;
        return { recommendations: this.latestRecommendations, generatedAt: this.latestRecommendationsAt };
    }

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

        const roundId = await TraceService.startRound();

        const plan = await DepositService.buildDepositPlan({
            refreshCandidates: options.refreshCandidates,
            refreshRecommendations: options.refreshRecommendations,
            maxActive: 10,
        });

        if (plan.recommendations.source === "claude") {
            await TraceService.recordClaudeDecision(roundId, 2, {
                model: plan.recommendations.model,
                top10: {
                    high: plan.recommendations.highConfidence,
                    low: plan.recommendations.lowConfidence,
                },
                allocations: plan.recommendations.suggestedAllocations ?? null,
                raw: plan.recommendations,
            });
        }

        // Persist the latest Claude recommendations for the premium endpoint to read.
        if (plan.recommendations.source === "claude") {
            this.latestRecommendations = plan.recommendations;
            this.latestRecommendationsAt = startedAt;
        }

        // If Claude ranking failed and we fell back to heuristic, abort rebalancing.
        // Heuristic scoring is unstable across cycles and causes unnecessary churn.
        if (plan.recommendations.source !== "claude") {
            logger.warn("Aborting rebalance: Claude ranking failed, heuristic fallback is too unstable for withdrawal decisions", {
                source: plan.recommendations.source,
            });
            await TraceService.endRound(roundId, "aborted", {
                reason: "claude-fallback",
                source: plan.recommendations.source,
            });
            return {
                startedAt,
                planTargets: plan.targets.length,
                recommended: [],
                tpWithdrawals: [],
                withdrawals: [],
                deposits: null,
            };
        }

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

        // Fetch market direction up-front so trim + withdrawal scans can both reference it.
        let marketDirection: "long" | "short" | "neutral" = "neutral";
        try {
            const marketData = await MarketDataService.getMarketOverlay();
            marketDirection = marketData.preferred_direction;
            await TraceService.recordMarketSnapshot(roundId, marketData);
        } catch (err: any) {
            logger.warn("Failed to fetch market direction for stop-loss check", {
                error: err?.message,
            });
        }

        const platformTvlUsd = positions.totalCapitalUsd ?? null;
        const recommendationByAddress = new Map(
            [
                ...plan.recommendations.highConfidence,
                ...plan.recommendations.lowConfidence,
            ].map((r) => [r.vaultAddress.toLowerCase(), r])
        );

        const snapshotForPosition = async (
            position: UserPosition,
            netDirection: "long" | "short" | "neutral" | null
        ): Promise<number | null> => {
            const rec = recommendationByAddress.get(
                position.vaultAddress.toLowerCase()
            );
            return TraceService.recordVaultSnapshot(roundId, {
                vaultAddress: position.vaultAddress,
                vaultName: position.vaultName ?? rec?.name ?? null,
                tvlUsd: rec?.metrics?.tvl ?? null,
                ageDays: rec?.metrics?.ageDays ?? null,
                followers: rec?.metrics?.followers ?? null,
                tradesLast7d: rec?.metrics?.tradesLast7d ?? null,
                pnl7d: rec?.metrics?.weeklyPnl ?? null,
                pnl30d: rec?.metrics?.monthlyPnl ?? null,
                pnlAlltime: rec?.metrics?.allTimePnl ?? null,
                netDirection,
                assumedBias: marketDirection,
            });
        };

        const recordEvent = async (
            position: UserPosition,
            action: PositionEventAction,
            snapshotId: number | null,
            extras: {
                amountUsd: number | null;
                targetEquityUsd: number | null;
                confidence: "high" | "low" | null;
                reasonText: string;
                txMeta?: any;
                succeeded?: boolean;
            }
        ): Promise<void> => {
            await TraceService.recordPositionEvent({
                roundId,
                vaultAddress: position.vaultAddress,
                vaultSnapshotId: snapshotId,
                action,
                amountUsd: extras.amountUsd,
                preEquityUsd: position.amountUsd ?? null,
                targetEquityUsd: extras.targetEquityUsd,
                confidence: extras.confidence,
                reasonText: extras.reasonText,
                txMeta: extras.txMeta ?? null,
                succeeded: extras.succeeded ?? true,
                hlPnlUsd: position.pnlUsd ?? null,
                platformTvlUsd,
            });
        };

        // Trim over-allocated recommended positions back to barbell target.
        const tpWithdrawals: VaultTransferAction[] = [];

        for (const position of positions.positions) {
            const address = position.vaultAddress.toLowerCase();

            if (!recommendedSet.has(address)) {
                continue;
            }

            const targetAllocation = targetAllocations.get(address);
            if (!targetAllocation) {
                continue;
            }

            const currentUsd = position.amountUsd ?? 0;
            const targetUsd = targetAllocation.targetUsd;

            if (currentUsd <= targetUsd) {
                continue;
            }

            const roePct = position.roePct ?? 0;
            logger.info("Trimming over-allocated recommended vault to target", {
                vaultAddress: address,
                vaultName: position.vaultName,
                currentUsd,
                targetUsd,
                excessUsd: currentUsd - targetUsd,
                roePct,
                confidence: targetAllocation.confidence,
            });

            const result = await RebalanceService.withdrawPartialFromVault({
                vaultAddress: address as `0x${string}`,
                targetAmountUsd: targetUsd,
                dryRun,
            });

            const submitted =
                result.action.status === "submitted" ||
                result.action.status === "prepared";
            if (submitted) {
                logger.info("Trim withdrawal executed", {
                    vaultAddress: address,
                    vaultName: position.vaultName,
                    withdrawnUsd: (result.action.usdMicros ?? 0) / 1e6,
                    remainingUsd: targetUsd,
                    roePct,
                    dryRun,
                });
            }

            const trimWithdrawn = (result.action.usdMicros ?? 0) / 1e6;
            const trimSnapshotId = await TraceService.recordVaultSnapshot(roundId, {
                vaultAddress: position.vaultAddress,
                vaultName: position.vaultName,
                tvlUsd: recommendationByAddress.get(address)?.metrics?.tvl ?? null,
                ageDays: recommendationByAddress.get(address)?.metrics?.ageDays ?? null,
                followers: recommendationByAddress.get(address)?.metrics?.followers ?? null,
                tradesLast7d: recommendationByAddress.get(address)?.metrics?.tradesLast7d ?? null,
                pnl7d: recommendationByAddress.get(address)?.metrics?.weeklyPnl ?? null,
                pnl30d: recommendationByAddress.get(address)?.metrics?.monthlyPnl ?? null,
                pnlAlltime: recommendationByAddress.get(address)?.metrics?.allTimePnl ?? null,
                assumedBias: marketDirection,
            });
            await TraceService.recordPositionEvent({
                roundId,
                vaultAddress: position.vaultAddress,
                vaultSnapshotId: trimSnapshotId,
                action: "trim",
                amountUsd: submitted ? -trimWithdrawn : 0,
                preEquityUsd: currentUsd,
                targetEquityUsd: targetUsd,
                confidence: targetAllocation.confidence,
                reasonText: "over-allocated-recommended",
                txMeta: result.action,
                succeeded: submitted,
                hlPnlUsd: position.pnlUsd ?? null,
                platformTvlUsd,
            });

            tpWithdrawals.push(result.action);
        }

        // Build deposit time map for hold period enforcement
        const depositTimeMap = await buildLastDepositTimeMap();
        const now = Date.now();
        const minHoldMs = MIN_HOLD_DAYS * MS_PER_DAY;

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
                    reason: "hard-stop-loss",
                });
                const snapshotId = await snapshotForPosition(position, null);
                const withdrawn = (result.action.usdMicros ?? 0) / 1e6;
                const submitted =
                    result.action.status === "submitted" ||
                    result.action.status === "prepared";
                await recordEvent(position, "exit_hard_sl", snapshotId, {
                    amountUsd: submitted ? -withdrawn : 0,
                    targetEquityUsd: 0,
                    confidence: null,
                    reasonText: `hard-stop-loss roe=${roePct}`,
                    txMeta: result.action,
                    succeeded: submitted,
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
                        reason: "stop-loss",
                    });
                    const snapshotId = await snapshotForPosition(position, vaultDirection);
                    const withdrawn = (result.action.usdMicros ?? 0) / 1e6;
                    const submitted =
                        result.action.status === "submitted" ||
                        result.action.status === "prepared";
                    await recordEvent(position, "exit_soft_sl", snapshotId, {
                        amountUsd: submitted ? -withdrawn : 0,
                        targetEquityUsd: 0,
                        confidence: null,
                        reasonText: `soft-stop-loss roe=${roePct} aligned=${isAligned} recommended=${isRecommended}`,
                        txMeta: result.action,
                        succeeded: submitted,
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
                const holdSnapshotId = await snapshotForPosition(position, vaultDirection);
                await recordEvent(position, "hold_soft_sl", holdSnapshotId, {
                    amountUsd: 0,
                    targetEquityUsd: position.amountUsd ?? null,
                    confidence: null,
                    reasonText: `held: recommended+aligned roe=${roePct}`,
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
                    reason: "inactive-vault",
                });
                const snapshotId = await snapshotForPosition(position, null);
                const withdrawn = (result.action.usdMicros ?? 0) / 1e6;
                const submitted =
                    result.action.status === "submitted" ||
                    result.action.status === "prepared";
                await recordEvent(position, "exit_inactive", snapshotId, {
                    amountUsd: submitted ? -withdrawn : 0,
                    targetEquityUsd: 0,
                    confidence: null,
                    reasonText: "inactive: 0 positions, 0 trades 7d",
                    txMeta: result.action,
                    succeeded: submitted,
                });
                withdrawals.push(result.action);
                continue;
            }

            // 4. Skip if still in recommendations (over-allocations already trimmed above)
            if (recommendedSet.has(address)) {
                const snapshotId = await snapshotForPosition(position, null);
                await recordEvent(position, "skip_recommended", snapshotId, {
                    amountUsd: 0,
                    targetEquityUsd: position.amountUsd ?? null,
                    confidence: null,
                    reasonText: "still recommended, no trim needed",
                });
                continue;
            }

            // 5. HOLD PERIOD: Don't rotate out of recently entered vaults (unless stop-loss, handled above)
            const lastDeposit = depositTimeMap.get(address);
            if (lastDeposit && (now - lastDeposit) < minHoldMs) {
                const holdDaysRemaining = ((minHoldMs - (now - lastDeposit)) / MS_PER_DAY).toFixed(1);
                const daysSinceDeposit = ((now - lastDeposit) / MS_PER_DAY).toFixed(1);
                logger.info("Skipping exit (minimum hold period not met)", {
                    vaultAddress: position.vaultAddress,
                    vaultName: position.vaultName,
                    roePct,
                    daysSinceDeposit,
                    minHoldDays: MIN_HOLD_DAYS,
                    holdDaysRemaining,
                    reason: "hold-period",
                });
                const snapshotId = await snapshotForPosition(position, null);
                await recordEvent(position, "hold_period", snapshotId, {
                    amountUsd: 0,
                    targetEquityUsd: position.amountUsd ?? null,
                    confidence: null,
                    reasonText: `hold-period: daysSinceDeposit=${daysSinceDeposit}, minHoldDays=${MIN_HOLD_DAYS}`,
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
                reason: "not-recommended",
            });
            const snapshotId = await snapshotForPosition(position, null);
            const withdrawn = (result.action.usdMicros ?? 0) / 1e6;
            const submitted =
                result.action.status === "submitted" ||
                result.action.status === "prepared";
            await recordEvent(position, "exit_not_recommended", snapshotId, {
                amountUsd: submitted ? -withdrawn : 0,
                targetEquityUsd: 0,
                confidence: null,
                reasonText: `not-recommended roe=${roePct}`,
                txMeta: result.action,
                succeeded: submitted,
            });
            withdrawals.push(result.action);
        }

        const hasSubmittedWithdrawals =
            withdrawals.some((action) => action.status === "submitted") ||
            tpWithdrawals.some((action) => action.status === "submitted");

        if (hasSubmittedWithdrawals) {
            const withdrawnVaults = [...withdrawals, ...tpWithdrawals]
                .filter((a) => a.status === "submitted")
                .map((a) => a.vaultAddress.toLowerCase());

            await waitForWithdrawalsToSettle(withdrawnVaults, withdrawalDelayMs);

            // Invalidate position caches so deposit plan sees fresh state
            VaultService.clearUserCaches();
        }

        // Rebuild deposit plan after withdrawals to pick up freed slots and the
        // freshly available perps balance — but reuse the original Claude-ranked
        // recommendation set. Re-running Claude here would double Anthropic spend
        // and add ~10-15 min per round, with no benefit (the same vaults are still
        // the right targets; only the dollar amounts need recomputing).
        const depositPlan = hasSubmittedWithdrawals
            ? await DepositService.buildDepositPlan({
                  refreshCandidates: false,
                  refreshRecommendations: false,
                  maxActive: 10,
                  recommendations: plan.recommendations,
              })
            : plan;

        if (hasSubmittedWithdrawals) {
            logger.info("Rebuilt deposit plan after withdrawals", {
                previousTargets: plan.targets.length,
                newTargets: depositPlan.targets.length,
            });
        }

        // Defense-in-depth: even with reuse, abort the deposit pass if the
        // recommendations are heuristic. Heuristic deposits are too unstable.
        if (depositPlan.recommendations.source !== "claude") {
            logger.warn(
                "Aborting deposit pass: recommendation source is heuristic, not deploying capital",
                {
                    source: depositPlan.recommendations.source,
                    targetCount: depositPlan.targets.length,
                }
            );
            await TraceService.endRound(roundId, "aborted", {
                reason: "heuristic-deposit-pass",
                tpWithdrawals: tpWithdrawals.length,
                withdrawals: withdrawals.length,
            });
            return {
                startedAt,
                planTargets: plan.targets.length,
                recommended,
                tpWithdrawals,
                withdrawals,
                deposits: null,
            };
        }

        const deposits = await DepositService.executeDepositPlan(depositPlan, {
            dryRun,
            minDepositUsd,
            roundId,
            platformTvlUsd,
            marketDirection,
        });

        // Categorize withdrawal reasons for analysis
        const withdrawalsByReason: Record<string, number> = {};
        for (const w of withdrawals) {
            const reason = w.reason ?? "unknown";
            withdrawalsByReason[reason] = (withdrawalsByReason[reason] ?? 0) + 1;
        }

        const summary = {
            tpWithdrawals: tpWithdrawals.length,
            tpSubmitted: tpWithdrawals.filter(a => a.status === "submitted").length,
            withdrawals: withdrawals.length,
            withdrawalsSubmitted: withdrawals.filter(a => a.status === "submitted").length,
            withdrawalsByReason,
            depositsTotal: deposits.total,
            depositsSubmitted: deposits.submitted,
            depositsSkipped: deposits.skipped,
            depositsErrors: deposits.errors,
            marketDirection,
            recommended: recommendedSet.size,
            positionsAfter: positions.totalPositions,
        };
        logger.info("Rebalance round completed", {
            startedAt,
            durationMs: Date.now() - new Date(startedAt).getTime(),
            dryRun,
            marketDirection,
            summary,
        });
        await TraceService.endRound(roundId, "completed", summary);
        // Stamp the post-round chart point using THIS round's position_event
        // deltas applied to the prior portfolio_series row. Decoupled from
        // HL's getUserVaultLedgerUpdates propagation (~3 min for vault txs),
        // which previously made an inline syncLedger here insert 0 rows and
        // leave the stamp holding pre-round aggregates → phantom PnL spike.
        await TraceService.recordPortfolioPoint({ roundId }).catch((error) => {
            logger.warn("recordPortfolioPoint failed (post-rebalance)", {
                message: error?.message,
            });
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
    const DEFAULT_HIGH_PCT = 80;
    const DEFAULT_LOW_PCT = 20;

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

const WITHDRAWAL_POLL_INTERVAL_MS = 10_000;
const WITHDRAWAL_DUST_USD = 1;

async function waitForWithdrawalsToSettle(
    vaultAddresses: string[],
    maxWaitMs: number
): Promise<void> {
    if (!vaultAddresses.length) return;
    const wallet = process.env.WALLET as `0x${string}` | undefined;
    if (!wallet) {
        logger.warn("No WALLET set, falling back to blind sleep for withdrawal settle");
        await sleep(maxWaitMs);
        return;
    }

    const pending = new Set(vaultAddresses.map((a) => a.toLowerCase()));
    const deadline = Date.now() + maxWaitMs;

    logger.info("Polling for withdrawal settlement", {
        vaults: vaultAddresses.length,
        maxWaitMs,
    });

    while (pending.size > 0 && Date.now() < deadline) {
        await sleep(WITHDRAWAL_POLL_INTERVAL_MS);
        try {
            const equities = await HyperliquidConnector.getUserVaultEquities(wallet);
            const equityMap = new Map(
                equities.map((e) => [e.vaultAddress.toLowerCase(), e.equity])
            );

            for (const vault of [...pending]) {
                const equity = equityMap.get(vault) ?? 0;
                if (equity < WITHDRAWAL_DUST_USD) {
                    pending.delete(vault);
                    logger.info("Withdrawal settled", { vault, remainingEquity: equity });
                }
            }

            if (pending.size > 0) {
                logger.info("Waiting for withdrawals to settle", {
                    remaining: pending.size,
                    vaults: [...pending],
                    timeLeftMs: deadline - Date.now(),
                });
            }
        } catch (error: any) {
            logger.warn("Error polling withdrawal status", { error: error?.message });
        }
    }

    if (pending.size > 0) {
        logger.warn("Withdrawal settlement timed out, proceeding with deposits", {
            unsettled: [...pending],
        });
    } else {
        logger.info("All withdrawals settled");
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
