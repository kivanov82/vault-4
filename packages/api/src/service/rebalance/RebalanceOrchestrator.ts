import { DepositService } from "./DepositService";
import { RebalanceService, type VaultTransferAction } from "./RebalanceService";
import { VaultService } from "../vaults/VaultService";
import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import { MarketDataService } from "../claude/MarketDataService";
import { logger } from "../utils/logger";
import { TraceService } from "../../db/TraceService";
import type { PositionEventAction } from "../../db/types";
import type { UserPosition } from "../vaults/types";
import { defaultExitConfig } from "./ExitPolicy";
import {
    verifyAndSettleWithdrawals,
    type WithdrawalVerifyEntry,
} from "./WithdrawalVerifier";
import { TrailingStopService } from "./TrailingStopService";
import * as RebalanceLock from "./RebalanceLock";

const exitConfig = defaultExitConfig();
const STOP_LOSS_PCT = exitConfig.stopLossPct;
const HARD_STOP_LOSS_PCT = exitConfig.hardStopLossPct;
const MIN_HOLD_DAYS = exitConfig.minHoldDays;
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
        // Mutual exclusion with RiskMonitor. Monitor ticks finish in well
        // under 2 minutes, so the wait is a formality; on timeout (a stuck
        // monitor) the round proceeds anyway — blocking all rebalancing
        // behind a wedged monitor would be the worse failure.
        const acquired = await RebalanceLock.acquireWithWait("round", 10 * 60 * 1000);
        if (!acquired) {
            logger.error(
                "Rebalance lock not released by RiskMonitor within 10 min — proceeding anyway"
            );
            RebalanceLock.release("monitor");
            RebalanceLock.tryAcquire("round");
        }
        try {
            return await this.runRoundInner(options);
        } finally {
            RebalanceLock.release("round");
        }
    }

    private static async runRoundInner(
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
            maxActive: 11,
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

            // 3. TRAILING STOP: ratchet the ROE high-water; exit on giveback
            // past the arm threshold. Runs for every position that reaches
            // this point so peaks stay fresh round-over-round. Ignores the
            // hold period and recommendation status — it is a protective
            // exit (like the stop-losses) whose trigger level always sits
            // in profit.
            const trailing = await TrailingStopService.observeAndCheck(position);
            if (trailing?.shouldExit) {
                logger.info("Trailing stop triggered", {
                    vaultAddress: position.vaultAddress,
                    vaultName: position.vaultName,
                    roePct,
                    peakRoePct: trailing.peakRoePct,
                    exitLevelRoePct: trailing.exitLevelRoePct,
                    pnlUsd,
                    reason: "trailing-stop",
                });
                const result = await RebalanceService.withdrawAllFromVault({
                    vaultAddress: position.vaultAddress as `0x${string}`,
                    dryRun,
                    includeLocked,
                    sweepDust: true,
                    reason: "trailing-stop",
                });
                const snapshotId = await snapshotForPosition(position, null);
                const withdrawn = (result.action.usdMicros ?? 0) / 1e6;
                const submitted =
                    result.action.status === "submitted" ||
                    result.action.status === "prepared";
                await recordEvent(position, "exit_trailing_stop", snapshotId, {
                    amountUsd: submitted ? -withdrawn : 0,
                    targetEquityUsd: 0,
                    confidence: null,
                    reasonText: `trailing-stop roe=${roePct} peak=${trailing.peakRoePct} exitLevel=${trailing.exitLevelRoePct?.toFixed(2)}`,
                    txMeta: result.action,
                    succeeded: submitted,
                });
                withdrawals.push(result.action);
                continue;
            }

            // 4. INACTIVE VAULT EXIT: Withdraw from vaults with 0 positions + 0 trades in 7d
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

            // 5. Skip if still in recommendations (over-allocations already trimmed above)
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

            // 6. HOLD PERIOD: Don't rotate out of recently entered vaults (unless stop-loss, handled above)
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

            // 7. EXIT NON-RECOMMENDED: vault is not recommended and the hold
            // period is met. Hysteresis: a profitable position gets
            // NOT_RECOMMENDED_EXIT_ROUNDS consecutive non-recommended rounds
            // before rotating out — Claude's ranking has round-to-round
            // variance, and 118 of 153 closed episodes were re-entries into
            // vaults we had just exited (each oscillation pays the leader's
            // profit share and resets the HL lockup + hold clock). Losing
            // positions still exit on the first non-recommended round.
            const exitAfterRounds = Math.max(1, exitConfig.notRecommendedRounds);
            if (exitAfterRounds > 1 && roePct >= 0) {
                const priorHolds = await TraceService.countHoldNotRecommendedStreak(
                    position.vaultAddress
                );
                // priorHolds === null ⇒ DB unavailable — fall back to the
                // pre-hysteresis behavior (exit now) so positions can't
                // become unkillable when the trace layer is down.
                const streak = priorHolds == null ? exitAfterRounds : priorHolds + 1;
                if (streak < exitAfterRounds) {
                    logger.info("Holding non-recommended vault (hysteresis)", {
                        vaultAddress: position.vaultAddress,
                        vaultName: position.vaultName,
                        roePct,
                        streak,
                        exitAfterRounds,
                        reason: "hold-not-recommended",
                    });
                    const snapshotId = await snapshotForPosition(position, null);
                    await recordEvent(position, "hold_not_recommended", snapshotId, {
                        amountUsd: 0,
                        targetEquityUsd: position.amountUsd ?? null,
                        confidence: null,
                        reasonText: `hold-not-recommended streak=${streak}/${exitAfterRounds} roe=${roePct}`,
                    });
                    continue;
                }
            }

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

        // Episode over for every submitted full exit — drop its trailing peak.
        for (const action of withdrawals) {
            if (action.status === "submitted") {
                await TrailingStopService.clearPeak(action.vaultAddress);
            }
        }

        const hasSubmittedWithdrawals =
            withdrawals.some((action) => action.status === "submitted") ||
            tpWithdrawals.some((action) => action.status === "submitted");

        let unsettledWithdrawals = 0;
        if (hasSubmittedWithdrawals) {
            const settleEntries: WithdrawalVerifyEntry[] = [
                ...withdrawals
                    .filter((a) => a.status === "submitted")
                    .map((a) => ({
                        vaultAddress: a.vaultAddress.toLowerCase(),
                        targetEquityUsd: 0,
                        kind: "full" as const,
                        reason: a.reason ?? "exit",
                        includeLocked,
                    })),
                ...tpWithdrawals
                    .filter((a) => a.status === "submitted")
                    .map((a) => ({
                        vaultAddress: a.vaultAddress.toLowerCase(),
                        targetEquityUsd:
                            targetAllocations.get(a.vaultAddress.toLowerCase())
                                ?.targetUsd ?? 0,
                        kind: "trim" as const,
                        reason: "trim-to-target",
                    })),
            ];

            const outcomes = await verifyAndSettleWithdrawals(settleEntries, {
                maxWaitMs: withdrawalDelayMs,
                dryRun,
                onRetry: async (notice) => {
                    const submitted =
                        notice.action.status === "submitted" ||
                        notice.action.status === "prepared";
                    const withdrawn = (notice.action.usdMicros ?? 0) / 1e6;
                    await TraceService.recordPositionEvent({
                        roundId,
                        vaultAddress: notice.entry.vaultAddress,
                        vaultSnapshotId: null,
                        action: notice.entry.kind === "full" ? "exit_retry" : "trim",
                        amountUsd: submitted ? -withdrawn : 0,
                        preEquityUsd: notice.preEquityUsd,
                        targetEquityUsd: notice.entry.targetEquityUsd,
                        confidence: null,
                        reasonText: `verify-retry attempt=${notice.attempt} original=${notice.entry.reason}`,
                        txMeta: notice.action,
                        succeeded: submitted,
                        hlPnlUsd: null,
                        platformTvlUsd,
                    });
                },
            });
            unsettledWithdrawals = outcomes.filter((o) => !o.settled).length;

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
                  maxActive: 11,
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
            unsettledWithdrawals,
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

// Min trim-target floor — matches DepositService.MIN_DEPOSIT_USD. Below this
// we don't emit a trim entry at all (see the comment on buildTargetAllocations).
const MIN_TRIM_TARGET_USD = 5;

// Trim targets are derived from each vault's Claude allocationPct, not from an
// even split inside the high/low buckets — so the trim pass undoes deviations
// from Claude's intent and matches what the deposit pass aims for.
//
// One critical guardrail: the trim pass has NO hold-period, stop-loss, or
// inactive-vault gates (those all live in the withdrawal pass). So if Claude
// returns allocationPct=0 for a still-recommended vault, naively trimming to
// $0 would full-exit the position, bypassing every protection. Instead, we
// drop those entries from the map entirely — the trim loop's
// `if (!targetAllocation) continue;` then skips them, and the withdrawal pass
// handles the exit with proper gates on the next round.
function buildTargetAllocations(
    recommendations: Awaited<ReturnType<typeof VaultService.getRecommendations>>,
    totalCapitalUsd: number
): Map<string, { targetUsd: number; confidence: "high" | "low" }> {
    const allocations = new Map<string, { targetUsd: number; confidence: "high" | "low" }>();
    const assign = (rec: { vaultAddress: string; allocationPct: number }, confidence: "high" | "low") => {
        const pct = Number.isFinite(rec.allocationPct) ? rec.allocationPct : 0;
        const targetUsd = totalCapitalUsd * (pct / 100);
        if (targetUsd < MIN_TRIM_TARGET_USD) return;
        allocations.set(rec.vaultAddress.toLowerCase(), { targetUsd, confidence });
    };
    for (const rec of recommendations.highConfidence) assign(rec, "high");
    for (const rec of recommendations.lowConfidence) assign(rec, "low");
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
