import { VaultService } from "../vaults/VaultService";
import { RebalanceService } from "./RebalanceService";
import { TrailingStopService } from "./TrailingStopService";
import * as RebalanceLock from "./RebalanceLock";
import { defaultExitConfig, shouldHardStop } from "./ExitPolicy";
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
 *
 * Soft stop-loss and rotation decisions need the Claude recommendation set
 * and market alignment, so they stay in the round scan. A tick that finds a
 * position already being handled by a running round defers entirely.
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

export type RiskMonitorRunResult = {
    checkedPositions: number;
    hardStopExits: number;
    trailingStopExits: number;
    skipped: "rebalance-running" | "already-running" | null;
};

export class RiskMonitor {
    private static started = false;
    private static intervalHandle: NodeJS.Timeout | null = null;
    private static startHandle: NodeJS.Timeout | null = null;

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

        const settleEntries: WithdrawalVerifyEntry[] = [];
        let hardStopExits = 0;
        let trailingStopExits = 0;

        for (const position of positions.positions) {
            const roePct = position.roePct;
            if (roePct == null || !Number.isFinite(roePct)) continue;

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
            trailingStopExits,
            skipped: null,
        };
        // Heartbeat on every tick — for a protective component, silence must
        // mean "disabled", never "maybe dead".
        logger.info("Risk monitor tick completed", { ...result });
        return result;
    }

    /** Submit a protective full exit + trace event. Returns true if submitted. */
    private static async exitPosition(
        position: UserPosition,
        action: "exit_risk_monitor" | "exit_trailing_stop",
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
    return { checkedPositions: 0, hardStopExits: 0, trailingStopExits: 0, skipped };
}
