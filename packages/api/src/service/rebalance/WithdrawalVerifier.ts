import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import { RebalanceService, type VaultTransferAction } from "./RebalanceService";
import { logger } from "../utils/logger";

/**
 * Withdrawal fill verification.
 *
 * HL accepts vault-withdrawal requests that can fill for $0 (e.g. when the
 * vault has no free margin to release) — the request "succeeds" but no funds
 * move. On 2026-06-02 a hard-stop-loss exit from Otter Quant filled $0.00,
 * went undetected, and the position decayed from $64.88 to $5.81 before the
 * next round retried 48h later.
 *
 * This module polls per-vault equity against the level each withdrawal should
 * leave behind (0 for full exits, the trim target for trims), and re-submits
 * withdrawals that did not move equity before the deadline.
 */

export type WithdrawalVerifyEntry = {
    vaultAddress: string;
    /** Equity expected to remain once the withdrawal settles (0 for full exits). */
    targetEquityUsd: number;
    kind: "full" | "trim";
    /** Original reason tag — reused (suffixed) on retries. */
    reason: string;
    includeLocked?: boolean;
};

export type WithdrawalRetryNotice = {
    entry: WithdrawalVerifyEntry;
    /** 1-based retry attempt number. */
    attempt: number;
    /** Vault equity observed just before the retry was submitted. */
    preEquityUsd: number | null;
    action: VaultTransferAction;
};

export type WithdrawalVerifyOutcome = {
    vaultAddress: string;
    settled: boolean;
    retries: number;
    finalEquityUsd: number | null;
};

const POLL_INTERVAL_MS = 10_000;
const WITHDRAWAL_DUST_USD = 1;
/** Settled when equity ≤ max(target × (1 + tolerance), dust). */
const TARGET_TOLERANCE = 0.05;

function maxRetries(): number {
    const raw = Number(process.env.WITHDRAWAL_VERIFY_MAX_RETRIES ?? 2);
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2;
}

function settleThresholdUsd(entry: WithdrawalVerifyEntry): number {
    return Math.max(entry.targetEquityUsd * (1 + TARGET_TOLERANCE), WITHDRAWAL_DUST_USD);
}

export async function verifyAndSettleWithdrawals(
    entries: WithdrawalVerifyEntry[],
    options: {
        maxWaitMs: number;
        dryRun: boolean;
        onRetry?: (notice: WithdrawalRetryNotice) => Promise<void>;
    }
): Promise<WithdrawalVerifyOutcome[]> {
    if (!entries.length) return [];
    const wallet = process.env.WALLET as `0x${string}` | undefined;
    if (!wallet) {
        logger.warn("No WALLET set, falling back to blind sleep for withdrawal settle");
        await sleep(options.maxWaitMs);
        return entries.map((e) => ({
            vaultAddress: e.vaultAddress,
            settled: false,
            retries: 0,
            finalEquityUsd: null,
        }));
    }

    const state = new Map(
        entries.map((e) => [
            e.vaultAddress.toLowerCase(),
            {
                entry: e,
                settled: false,
                retries: 0,
                finalEquityUsd: null as number | null,
            },
        ])
    );

    const retryBudget = options.dryRun ? 0 : maxRetries();
    // One poll window for the initial submissions plus one per retry cycle.
    for (let cycle = 0; cycle <= retryBudget; cycle++) {
        await pollUntilSettled(wallet, state, options.maxWaitMs);

        const unsettled = [...state.values()].filter((s) => !s.settled);
        if (!unsettled.length) break;
        if (cycle === retryBudget) break;

        for (const s of unsettled) {
            const attempt = s.retries + 1;
            logger.warn("Withdrawal did not settle — re-submitting", {
                vaultAddress: s.entry.vaultAddress,
                kind: s.entry.kind,
                reason: s.entry.reason,
                targetEquityUsd: s.entry.targetEquityUsd,
                observedEquityUsd: s.finalEquityUsd,
                attempt,
            });
            try {
                const action = await resubmit(s.entry, options.dryRun);
                s.retries = attempt;
                if (options.onRetry) {
                    await options.onRetry({
                        entry: s.entry,
                        attempt,
                        preEquityUsd: s.finalEquityUsd,
                        action,
                    });
                }
            } catch (error: any) {
                s.retries = attempt;
                logger.warn("Withdrawal retry submission failed", {
                    vaultAddress: s.entry.vaultAddress,
                    attempt,
                    error: error?.message,
                });
            }
        }
    }

    const outcomes = [...state.values()].map((s) => ({
        vaultAddress: s.entry.vaultAddress,
        settled: s.settled,
        retries: s.retries,
        finalEquityUsd: s.finalEquityUsd,
    }));

    const failed = outcomes.filter((o) => !o.settled);
    if (failed.length) {
        logger.error("Withdrawals unsettled after verification retries", {
            failed: failed.map((f) => ({
                vault: f.vaultAddress,
                retries: f.retries,
                equityUsd: f.finalEquityUsd,
            })),
        });
    } else {
        logger.info("All withdrawals settled", {
            vaults: outcomes.length,
            retriesUsed: outcomes.reduce((sum, o) => sum + o.retries, 0),
        });
    }
    return outcomes;
}

async function pollUntilSettled(
    wallet: `0x${string}`,
    state: Map<
        string,
        {
            entry: WithdrawalVerifyEntry;
            settled: boolean;
            retries: number;
            finalEquityUsd: number | null;
        }
    >,
    maxWaitMs: number
): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    const pendingCount = () => [...state.values()].filter((s) => !s.settled).length;

    logger.info("Polling for withdrawal settlement", {
        vaults: pendingCount(),
        maxWaitMs,
    });

    while (pendingCount() > 0 && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        try {
            const equities = await HyperliquidConnector.getUserVaultEquities(wallet);
            const equityMap = new Map(
                equities.map((e) => [e.vaultAddress.toLowerCase(), e.equity])
            );

            for (const s of state.values()) {
                if (s.settled) continue;
                const equity = equityMap.get(s.entry.vaultAddress.toLowerCase()) ?? 0;
                s.finalEquityUsd = equity;
                if (equity <= settleThresholdUsd(s.entry)) {
                    s.settled = true;
                    logger.info("Withdrawal settled", {
                        vault: s.entry.vaultAddress,
                        kind: s.entry.kind,
                        remainingEquity: equity,
                    });
                }
            }
        } catch (error: any) {
            logger.warn("Error polling withdrawal status", { error: error?.message });
        }
    }
}

// dryRun is unreachable today (retryBudget is 0 in dry runs) but threaded
// through so a future change to the retry gating can't fire live withdrawals.
async function resubmit(
    entry: WithdrawalVerifyEntry,
    dryRun: boolean
): Promise<VaultTransferAction> {
    if (entry.kind === "trim") {
        const result = await RebalanceService.withdrawPartialFromVault({
            vaultAddress: entry.vaultAddress as `0x${string}`,
            targetAmountUsd: entry.targetEquityUsd,
            dryRun,
        });
        return result.action;
    }
    const result = await RebalanceService.withdrawAllFromVault({
        vaultAddress: entry.vaultAddress as `0x${string}`,
        dryRun,
        includeLocked: entry.includeLocked ?? false,
        sweepDust: true,
        reason: `${entry.reason}-retry`,
    });
    return result.action;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
