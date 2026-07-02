import { VaultService } from "../vaults/VaultService";
import { RebalanceService } from "./RebalanceService";
import { TrailingStopService } from "./TrailingStopService";
import * as RebalanceLock from "./RebalanceLock";
import {
    defaultExitConfig,
    shouldHardStop,
    shouldIntraRoundSoftStop,
} from "./ExitPolicy";
import {
    getVaultNetDirection,
    resolveRecommendedSet,
} from "./RebalanceOrchestrator";
import { MarketDataService } from "../claude/MarketDataService";
import {
    verifyAndSettleWithdrawals,
    type WithdrawalVerifyEntry,
} from "./WithdrawalVerifier";
import { TraceService } from "../../db/TraceService";
import { logger } from "../utils/logger";
import type { UserPosition } from "../vaults/types";

/**
 * Intra-round risk monitor.
 *
 * The rebalance round runs every 48h, which historically left stop-losses
 * blind between rounds: Otter Quant went from -11.6% ROE to -70.5% inside one
 * such window (2026-05-31 → 06-02) before the round-boundary hard stop could
 * fire. This monitor re-checks every open position every
 * RISK_MONITOR_INTERVAL_MS (default 4h) and fires protective exits only:
 *
 *  - hard stop-loss (unconditional, same threshold as the round scan)
 *  - trailing stop (peak-ROE giveback, shared TrailingStopService state)
 *  - gated soft stop-loss (opt-in, RISK_MONITOR_SOFT_SL_ENABLED) — closes the
 *    −15% → −22% bleed that the 48h round scan misses (2026-06 Realist Capital,
 *    −$78), but only for positions that are non-recommended AND misaligned AND
 *    still falling, so it does not whipsaw the recoverable dips that the
 *    backtest showed a blanket intra-round soft stop would sell. Uses the
 *    recommendation set stashed by the round + the current market overlay.
 *
 * Full rotation decisions still need the live Claude ranking, so they stay in
 * the round scan. A tick that finds a position already being handled by a
 * running round defers entirely.
 */

const HOUR_MS = 60 * 60 * 1000;

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null || raw === "") return fallback;
    const num = Number(raw);
    return Number.isFinite(num) ? num : fallback;
}

const INTERVAL_MS = envNumber("RISK_MONITOR_INTERVAL_MS", 4 * HOUR_MS);
const INITIAL_DELAY_MS = envNumber("RISK_MONITOR_INITIAL_DELAY_MS", 10 * 60 * 1000);
const SETTLE_WAIT_MS = envNumber("RISK_MONITOR_SETTLE_WAIT_MS", 60_000);

// Gated intra-round soft stop-loss. ON by default, with a kill switch
// (RISK_MONITOR_SOFT_SL_ENABLED=false) matching the RISK_MONITOR_ENABLED /
// TRAILING_STOP_ENABLED convention. The gate is deliberately strict — it fires
// only on non-recommended + misaligned + still-falling positions — because the
// 2026-06 backtest showed a blanket intra-round soft stop whipsaws recoverable
// dips (see STRATEGY-FORENSICS-2026-06.md §6).
const SOFT_SL_ENABLED = (process.env.RISK_MONITOR_SOFT_SL_ENABLED ?? "true") !== "false";
// The recommendation set is stashed in-memory by the round. If it is older than
// this (a round runs every ~2 days), treat it as stale and decline to fire the
// soft stop rather than risk acting on an outdated set after a long outage.
const RECOMMENDED_MAX_AGE_MS = envNumber(
    "RISK_MONITOR_RECOMMENDED_MAX_AGE_MS",
    3 * 24 * HOUR_MS
);

export type RiskMonitorRunResult = {
    checkedPositions: number;
    hardStopExits: number;
    softStopExits: number;
    trailingStopExits: number;
    skipped: "rebalance-running" | "already-running" | null;
};

export class RiskMonitor {
    private static started = false;
    private static intervalHandle: NodeJS.Timeout | null = null;
    private static startHandle: NodeJS.Timeout | null = null;
    /**
     * Last-tick ROE per held vault, for the gated soft stop's "still
     * deteriorating" check. In-memory; pruned to currently-held vaults each
     * tick. A vault with no prior entry (first tick / freshly opened) cannot
     * fire the soft stop until a second observation confirms a downward step.
     */
    private static lastRoeByVault = new Map<string, number>();

    static async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        if ((process.env.REBALANCE_ENABLED ?? "true") === "false") {
            logger.info("Risk monitor disabled (REBALANCE_ENABLED=false)");
            return;
        }
        if ((process.env.RISK_MONITOR_ENABLED ?? "true") === "false") {
            logger.info("Risk monitor disabled");
            return;
        }

        logger.info("Risk monitor initialized", {
            intervalMs: INTERVAL_MS,
            initialDelayMs: INITIAL_DELAY_MS,
        });

        this.startHandle = setTimeout(() => {
            void this.runOnce();
            this.intervalHandle = setInterval(() => {
                void this.runOnce();
            }, INTERVAL_MS);
        }, INITIAL_DELAY_MS);
    }

    static async runOnce(): Promise<RiskMonitorRunResult> {
        // Shared lock with the rebalance round: a tick never runs while a
        // round is executing, and a round waits for a tick to finish — the
        // two can otherwise submit duplicate withdrawals for the same vault.
        if (!RebalanceLock.tryAcquire("monitor")) {
            const holder = RebalanceLock.heldBy();
            if (holder === "round") {
                logger.info("Risk monitor tick skipped: rebalance round in progress");
                return emptyResult("rebalance-running");
            }
            return emptyResult("already-running");
        }
        try {
            return await this.scanPositions();
        } catch (error: any) {
            logger.warn("Risk monitor tick failed", { error: error?.message });
            return emptyResult(null);
        } finally {
            RebalanceLock.release("monitor");
        }
    }

    private static async scanPositions(): Promise<RiskMonitorRunResult> {
        const config = defaultExitConfig();
        const positions = await VaultService.getPlatformPositions({ refresh: true });
        const platformTvlUsd = positions.totalCapitalUsd ?? null;

        // Self-healing: drop trailing peaks for vaults we no longer hold.
        await TrailingStopService.sweepClosedPeaks(
            positions.positions.map((p) => p.vaultAddress)
        );

        // Prune the soft-stop ROE memory to currently-held vaults (mirrors the
        // trailing-peak sweep) so a re-entered vault starts a fresh trend.
        const heldAddrs = new Set(
            positions.positions.map((p) => p.vaultAddress.toLowerCase())
        );
        for (const addr of this.lastRoeByVault.keys()) {
            if (!heldAddrs.has(addr)) this.lastRoeByVault.delete(addr);
        }

        // Resolve the gated soft-stop context once per tick. It needs Claude's
        // last recommendation set (stashed by the round) and the current market
        // direction. We decline to fire — rather than guess — when the set is
        // missing/stale or the regime is neutral (everything counts as aligned,
        // so the soft stop could never fire anyway).
        const softCtx = SOFT_SL_ENABLED
            ? await this.resolveSoftStopContext()
            : null;

        const settleEntries: WithdrawalVerifyEntry[] = [];
        let hardStopExits = 0;
        let softStopExits = 0;
        let trailingStopExits = 0;

        for (const position of positions.positions) {
            const roePct = position.roePct;
            if (roePct == null || !Number.isFinite(roePct)) continue;
            const addrLower = position.vaultAddress.toLowerCase();
            const prevRoePct = this.lastRoeByVault.get(addrLower) ?? null;

            if (shouldHardStop(roePct, config)) {
                logger.info("Risk monitor: hard stop-loss triggered", {
                    vaultAddress: position.vaultAddress,
                    vaultName: position.vaultName,
                    roePct,
                    threshold: config.hardStopLossPct,
                    reason: "risk-monitor-hard-sl",
                });
                const submitted = await this.exitPosition(
                    position,
                    "exit_risk_monitor",
                    `risk-monitor hard-stop-loss roe=${roePct}`,
                    "risk-monitor-hard-sl",
                    platformTvlUsd,
                    settleEntries
                );
                if (submitted) hardStopExits += 1;
                continue;
            }

            // Gated intra-round soft stop: only an abandoned (not recommended),
            // counter-regime, still-deteriorating position in the soft band.
            // Per-vault direction is only queried when the cheap gates already
            // pass, so a healthy book costs no extra HL calls.
            if (
                softCtx &&
                roePct <= config.stopLossPct &&
                !softCtx.recommended.has(addrLower)
            ) {
                const vaultDirection = await getVaultNetDirection(
                    position.vaultAddress
                );
                const isAligned =
                    vaultDirection === softCtx.marketDirection ||
                    softCtx.marketDirection === "neutral";
                if (
                    shouldIntraRoundSoftStop(
                        roePct,
                        prevRoePct,
                        false, // not in the recommended set (checked above)
                        isAligned,
                        config
                    )
                ) {
                    logger.info("Risk monitor: gated soft stop-loss triggered", {
                        vaultAddress: position.vaultAddress,
                        vaultName: position.vaultName,
                        roePct,
                        prevRoePct,
                        threshold: config.stopLossPct,
                        vaultDirection,
                        marketDirection: softCtx.marketDirection,
                        reason: "risk-monitor-soft-sl",
                    });
                    const submitted = await this.exitPosition(
                        position,
                        "exit_soft_sl",
                        `risk-monitor soft-stop-loss roe=${roePct} prev=${prevRoePct} aligned=${isAligned} recommended=false`,
                        "risk-monitor-soft-sl",
                        platformTvlUsd,
                        settleEntries
                    );
                    if (submitted) softStopExits += 1;
                    continue;
                }
            }

            const trailing = await TrailingStopService.observeAndCheck(position);
            if (trailing?.shouldExit) {
                logger.info("Risk monitor: trailing stop triggered", {
                    vaultAddress: position.vaultAddress,
                    vaultName: position.vaultName,
                    roePct,
                    peakRoePct: trailing.peakRoePct,
                    exitLevelRoePct: trailing.exitLevelRoePct,
                    reason: "risk-monitor-trailing-stop",
                });
                const submitted = await this.exitPosition(
                    position,
                    "exit_trailing_stop",
                    `risk-monitor trailing-stop roe=${roePct} peak=${trailing.peakRoePct} exitLevel=${trailing.exitLevelRoePct?.toFixed(2)}`,
                    "risk-monitor-trailing-stop",
                    platformTvlUsd,
                    settleEntries
                );
                if (submitted) trailingStopExits += 1;
            }

            // Record this tick's ROE for next tick's "still deteriorating"
            // check. Exited positions fall out via the held-vaults prune above.
            this.lastRoeByVault.set(addrLower, roePct);
        }

        if (settleEntries.length) {
            await verifyAndSettleWithdrawals(settleEntries, {
                maxWaitMs: SETTLE_WAIT_MS,
                dryRun: false,
                onRetry: async (notice) => {
                    const submitted =
                        notice.action.status === "submitted" ||
                        notice.action.status === "prepared";
                    const withdrawn = (notice.action.usdMicros ?? 0) / 1e6;
                    await TraceService.recordPositionEvent({
                        roundId: null,
                        vaultAddress: notice.entry.vaultAddress,
                        vaultSnapshotId: null,
                        action: "exit_retry",
                        amountUsd: submitted ? -withdrawn : 0,
                        preEquityUsd: notice.preEquityUsd,
                        targetEquityUsd: 0,
                        confidence: null,
                        reasonText: `verify-retry attempt=${notice.attempt} original=${notice.entry.reason}`,
                        txMeta: notice.action,
                        succeeded: submitted,
                        hlPnlUsd: null,
                        platformTvlUsd,
                    });
                },
            });
            VaultService.clearUserCaches();
            // Pull the HL ledger so position_account picks up the exit as
            // soon as HL propagates it (~3 min). The portfolio chart point
            // itself is stamped at round boundaries; the 5-minute
            // periodicTraceSync heals any realized/basis drift in between,
            // so no eager portfolio_series stamp here (an immediate stamp
            // would freeze pre-sync basis against post-exit equity — the
            // exact phantom-PnL artifact the round-end settle-poll fixed).
            await TraceService.syncLedger().catch((error: any) => {
                logger.warn("Risk monitor ledger sync failed", {
                    message: error?.message,
                });
            });
        }

        const result: RiskMonitorRunResult = {
            checkedPositions: positions.positions.length,
            hardStopExits,
            softStopExits,
            trailingStopExits,
            skipped: null,
        };
        // Heartbeat on every tick — for a protective component, silence must
        // mean "disabled", never "maybe dead".
        logger.info("Risk monitor tick completed", { ...result });
        return result;
    }

    /**
     * Resolve the gated soft-stop context for this tick, or null when we should
     * decline to fire (no/stale recommendation set, neutral regime, or the
     * market overlay is unavailable). Fail-safe: any uncertainty ⇒ no soft exit.
     */
    private static async resolveSoftStopContext(): Promise<{
        recommended: Set<string>;
        marketDirection: "long" | "short" | "neutral";
    } | null> {
        // In-memory stash with DB fallback (persisted stage-2 decision), so a
        // process restart between rounds doesn't blind the gated soft stop.
        const resolved = await resolveRecommendedSet(RECOMMENDED_MAX_AGE_MS);
        if (!resolved) {
            logger.info(
                "Risk monitor: soft stop skipped — recommendation set missing or stale"
            );
            return null;
        }
        const { set } = resolved;
        try {
            const market = await MarketDataService.getMarketOverlay();
            if (market.preferred_direction === "neutral") return null;
            return { recommended: set, marketDirection: market.preferred_direction };
        } catch (error: any) {
            logger.warn("Risk monitor: soft stop skipped — market overlay unavailable", {
                error: error?.message,
            });
            return null;
        }
    }

    /** Submit a protective full exit + trace event. Returns true if submitted. */
    private static async exitPosition(
        position: UserPosition,
        action: "exit_risk_monitor" | "exit_trailing_stop" | "exit_soft_sl",
        reasonText: string,
        reason: string,
        platformTvlUsd: number | null,
        settleEntries: WithdrawalVerifyEntry[]
    ): Promise<boolean> {
        const result = await RebalanceService.withdrawAllFromVault({
            vaultAddress: position.vaultAddress as `0x${string}`,
            dryRun: false,
            includeLocked: false,
            sweepDust: true,
            reason,
        });
        const submitted = result.action.status === "submitted";
        const withdrawn = (result.action.usdMicros ?? 0) / 1e6;
        await TraceService.recordPositionEvent({
            roundId: null,
            vaultAddress: position.vaultAddress,
            vaultSnapshotId: null,
            action,
            amountUsd: submitted ? -withdrawn : 0,
            preEquityUsd: position.amountUsd ?? null,
            targetEquityUsd: 0,
            confidence: null,
            reasonText,
            txMeta: result.action,
            succeeded: submitted,
            hlPnlUsd: position.pnlUsd ?? null,
            platformTvlUsd,
        });
        if (submitted) {
            await TrailingStopService.clearPeak(position.vaultAddress);
            settleEntries.push({
                vaultAddress: position.vaultAddress.toLowerCase(),
                targetEquityUsd: 0,
                kind: "full",
                reason,
            });
        } else if (result.action.status === "error") {
            logger.warn("Risk monitor exit failed", {
                vaultAddress: position.vaultAddress,
                error: result.action.error,
            });
        }
        return submitted;
    }
}

function emptyResult(
    skipped: RiskMonitorRunResult["skipped"]
): RiskMonitorRunResult {
    return {
        checkedPositions: 0,
        hardStopExits: 0,
        softStopExits: 0,
        trailingStopExits: 0,
        skipped,
    };
}
