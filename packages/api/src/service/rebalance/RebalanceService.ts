import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import { logger } from "../utils/logger";

export type WithdrawAllOptions = {
    userAddress?: `0x${string}`;
    includeLocked?: boolean;
    dryRun?: boolean;
    usdBufferBps?: number;
    sweepDust?: boolean;
};

export type VaultTransferAction = {
    vaultAddress: string;
    equity?: number;
    lockedUntilTimestamp?: number;
    usdMicros: number;
    status: "skipped" | "prepared" | "submitted" | "error";
    reason?: string;
    error?: string;
};

export type WithdrawAllResult = {
    userAddress: `0x${string}`;
    total: number;
    submitted: number;
    skipped: number;
    errors: number;
    dryRun: boolean;
    actions: VaultTransferAction[];
};

export type WithdrawVaultOptions = {
    userAddress?: `0x${string}`;
    vaultAddress: `0x${string}`;
    includeLocked?: boolean;
    dryRun?: boolean;
    usdBufferBps?: number;
    sweepDust?: boolean;
};

export type WithdrawVaultResult = {
    userAddress: `0x${string}`;
    dryRun: boolean;
    action: VaultTransferAction;
};

export type WithdrawPartialOptions = {
    userAddress?: `0x${string}`;
    vaultAddress: `0x${string}`;
    targetAmountUsd: number;
    dryRun?: boolean;
    usdBufferBps?: number;
};

export type WithdrawPartialResult = {
    userAddress: `0x${string}`;
    dryRun: boolean;
    action: VaultTransferAction;
};

export type DepositVaultOptions = {
    vaultAddress: `0x${string}`;
    amountUsd?: number;
    usdMicros?: number;
    dryRun?: boolean;
};

export type DepositVaultResult = {
    dryRun: boolean;
    action: VaultTransferAction;
};

const DEFAULT_USD_BUFFER_BPS = 10; // 0.10% buffer to avoid rounding issues

export class RebalanceService {
    static async withdrawAllUserVaults(
        options: WithdrawAllOptions = {}
    ): Promise<WithdrawAllResult> {
        const userAddress = (options.userAddress ??
            (process.env.WALLET as `0x${string}`)) as `0x${string}`;
        if (!userAddress) {
            throw new Error("WALLET is not set");
        }
        const includeLocked = options.includeLocked ?? false;
        const dryRun = options.dryRun ?? true;
        const usdBufferBps =
            options.usdBufferBps ?? DEFAULT_USD_BUFFER_BPS;
        const sweepDust = options.sweepDust ?? false;

        const equities = await HyperliquidConnector.getUserVaultEquities(
            userAddress
        );
        const now = Date.now();

        let submitted = 0;
        let skipped = 0;
        let errors = 0;
        const actions: VaultTransferAction[] = [];

        for (const equity of equities) {
            const action = await withdrawFromEquity(equity, {
                includeLocked,
                dryRun,
                usdBufferBps,
                sweepDust,
                now,
            });
            actions.push(action);
            if (action.status === "submitted") submitted += 1;
            if (action.status === "skipped") skipped += 1;
            if (action.status === "error") errors += 1;
        }

        return {
            userAddress,
            total: equities.length,
            submitted,
            skipped,
            errors,
            dryRun,
            actions,
        };
    }

    static async withdrawAllFromVault(
        options: WithdrawVaultOptions
    ): Promise<WithdrawVaultResult> {
        const userAddress = (options.userAddress ??
            (process.env.WALLET as `0x${string}`)) as `0x${string}`;
        if (!userAddress) {
            throw new Error("WALLET is not set");
        }
        const includeLocked = options.includeLocked ?? false;
        const dryRun = options.dryRun ?? true;
        const usdBufferBps =
            options.usdBufferBps ?? DEFAULT_USD_BUFFER_BPS;
        const sweepDust = options.sweepDust ?? false;
        const equities = await HyperliquidConnector.getUserVaultEquities(
            userAddress
        );
        const equity = equities.find(
            (entry) =>
                entry.vaultAddress.toLowerCase() ===
                options.vaultAddress.toLowerCase()
        );
        if (!equity) {
            return {
                userAddress,
                dryRun,
                action: {
                    vaultAddress: options.vaultAddress,
                    usdMicros: 0,
                    status: "skipped",
                    reason: "not-deposited",
                },
            };
        }
        const action = await withdrawFromEquity(equity, {
            includeLocked,
            dryRun,
            usdBufferBps,
            sweepDust,
            now: Date.now(),
        });
        return { userAddress, dryRun, action };
    }

    static async withdrawPartialFromVault(
        options: WithdrawPartialOptions
    ): Promise<WithdrawPartialResult> {
        const userAddress = (options.userAddress ??
            (process.env.WALLET as `0x${string}`)) as `0x${string}`;
        if (!userAddress) {
            throw new Error("WALLET is not set");
        }
        const dryRun = options.dryRun ?? true;
        const usdBufferBps =
            options.usdBufferBps ?? DEFAULT_USD_BUFFER_BPS;

        const equities = await HyperliquidConnector.getUserVaultEquities(
            userAddress
        );
        const equity = equities.find(
            (entry) =>
                entry.vaultAddress.toLowerCase() ===
                options.vaultAddress.toLowerCase()
        );

        if (!equity) {
            return {
                userAddress,
                dryRun,
                action: {
                    vaultAddress: options.vaultAddress,
                    usdMicros: 0,
                    status: "skipped",
                    reason: "not-deposited",
                },
            };
        }

        const currentEquityUsd = equity.equity;
        const targetAmountUsd = options.targetAmountUsd;

        if (currentEquityUsd <= targetAmountUsd) {
            return {
                userAddress,
                dryRun,
                action: {
                    vaultAddress: options.vaultAddress,
                    equity: currentEquityUsd,
                    usdMicros: 0,
                    status: "skipped",
                    reason: "already-at-target",
                },
            };
        }

        const withdrawAmountUsd = currentEquityUsd - targetAmountUsd;
        const withdrawMicros = toUsdMicros(withdrawAmountUsd, usdBufferBps);

        if (withdrawMicros <= 0) {
            return {
                userAddress,
                dryRun,
                action: {
                    vaultAddress: options.vaultAddress,
                    equity: currentEquityUsd,
                    usdMicros: 0,
                    status: "skipped",
                    reason: "zero-amount",
                },
            };
        }

        if (dryRun) {
            return {
                userAddress,
                dryRun,
                action: {
                    vaultAddress: options.vaultAddress,
                    equity: currentEquityUsd,
                    usdMicros: withdrawMicros,
                    status: "prepared",
                    reason: "take-profit",
                },
            };
        }

        // Use progressive retry to handle margin requirements
        const result = await attemptWithdrawalWithRetry(
            options.vaultAddress,
            withdrawMicros
        );

        if (result.status === "submitted") {
            return {
                userAddress,
                dryRun,
                action: {
                    vaultAddress: options.vaultAddress,
                    equity: currentEquityUsd,
                    usdMicros: result.actualUsdMicros ?? withdrawMicros,
                    status: "submitted",
                    reason: "take-profit",
                },
            };
        }

        return {
            userAddress,
            dryRun,
            action: {
                vaultAddress: options.vaultAddress,
                equity: currentEquityUsd,
                usdMicros: withdrawMicros,
                status: "error",
                error: result.error,
            },
        };
    }

    static async depositToVault(
        options: DepositVaultOptions
    ): Promise<DepositVaultResult> {
        const usdMicros = toUsdMicrosFromDeposit(options);
        if (usdMicros <= 0) {
            return {
                dryRun: options.dryRun ?? true,
                action: {
                    vaultAddress: options.vaultAddress,
                    usdMicros,
                    status: "skipped",
                    reason: "zero-amount",
                },
            };
        }
        const dryRun = options.dryRun ?? true;
        if (dryRun) {
            return {
                dryRun,
                action: {
                    vaultAddress: options.vaultAddress,
                    usdMicros,
                    status: "prepared",
                },
            };
        }
        try {
            await HyperliquidConnector.vaultTransfer(
                options.vaultAddress,
                true,
                usdMicros
            );
            return {
                dryRun,
                action: {
                    vaultAddress: options.vaultAddress,
                    usdMicros,
                    status: "submitted",
                },
            };
        } catch (error: any) {
            logger.warn("Deposit failed", {
                vaultAddress: options.vaultAddress,
                message: error?.message,
            });
            return {
                dryRun,
                action: {
                    vaultAddress: options.vaultAddress,
                    usdMicros,
                    status: "error",
                    error: error?.message ?? String(error),
                },
            };
        }
    }
}

function toUsdMicros(amountUsd: number, bufferBps: number): number {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return 0;
    const buffered = amountUsd * (1 - bufferBps / 10000);
    return Math.max(0, Math.floor(buffered * 1e6));
}

function toUsdMicrosFromDeposit(options: DepositVaultOptions): number {
    if (Number.isFinite(options.usdMicros)) {
        return Math.max(0, Math.floor(Number(options.usdMicros)));
    }
    if (Number.isFinite(options.amountUsd)) {
        return Math.max(0, Math.floor(Number(options.amountUsd) * 1e6));
    }
    return 0;
}

async function withdrawFromEquity(
    equity: { vaultAddress: string; equity: number; lockedUntilTimestamp: number },
    options: {
        includeLocked: boolean;
        dryRun: boolean;
        usdBufferBps: number;
        sweepDust: boolean;
        now: number;
    }
): Promise<VaultTransferAction> {
    const isLocked =
        equity.lockedUntilTimestamp > 0 &&
        equity.lockedUntilTimestamp > options.now;
    if (isLocked && !options.includeLocked) {
        return {
            vaultAddress: equity.vaultAddress,
            equity: equity.equity,
            lockedUntilTimestamp: equity.lockedUntilTimestamp,
            usdMicros: 0,
            status: "skipped",
            reason: "locked",
        };
    }

    const bufferedMicros = toUsdMicros(equity.equity, options.usdBufferBps);
    const fullMicros = toUsdMicros(equity.equity, 0);
    const targetMicros = bufferedMicros > 0 ? bufferedMicros : fullMicros;

    if (targetMicros <= 0) {
        return {
            vaultAddress: equity.vaultAddress,
            equity: equity.equity,
            lockedUntilTimestamp: equity.lockedUntilTimestamp,
            usdMicros: targetMicros,
            status: "skipped",
            reason: "zero-amount",
        };
    }

    if (options.dryRun) {
        return {
            vaultAddress: equity.vaultAddress,
            equity: equity.equity,
            lockedUntilTimestamp: equity.lockedUntilTimestamp,
            usdMicros: targetMicros,
            status: "prepared",
        };
    }

    // Use progressive retry to handle margin requirements
    const result = await attemptWithdrawalWithRetry(equity.vaultAddress, targetMicros);
    if (result.status === "submitted") {
        return {
            vaultAddress: equity.vaultAddress,
            equity: equity.equity,
            lockedUntilTimestamp: equity.lockedUntilTimestamp,
            usdMicros: result.actualUsdMicros ?? targetMicros,
            status: "submitted",
        };
    }

    return {
        vaultAddress: equity.vaultAddress,
        equity: equity.equity,
        lockedUntilTimestamp: equity.lockedUntilTimestamp,
        usdMicros: targetMicros,
        status: "error",
        error: result.error,
    };
}

async function attemptWithdrawal(
    vaultAddress: string,
    usdMicros: number
): Promise<{ status: "submitted" | "error"; error?: string; actualUsdMicros?: number }> {
    try {
        await HyperliquidConnector.vaultTransfer(
            vaultAddress as `0x${string}`,
            false,
            usdMicros
        );
        return { status: "submitted", actualUsdMicros: usdMicros };
    } catch (error: any) {
        const message = error?.message ?? String(error);
        logger.warn("Withdraw failed", { vaultAddress, message });
        return { status: "error", error: message };
    }
}

// Progressive retry percentages when withdrawal fails due to insufficient equity
const WITHDRAWAL_RETRY_PERCENTAGES = [0.95, 0.90, 0.85, 0.80, 0.75, 0.70, 0.60, 0.50];
const MIN_WITHDRAWAL_USD = 1; // Don't retry below $1

async function attemptWithdrawalWithRetry(
    vaultAddress: string,
    initialUsdMicros: number
): Promise<{ status: "submitted" | "error"; error?: string; actualUsdMicros?: number }> {
    // First attempt with the requested amount
    const initial = await attemptWithdrawal(vaultAddress, initialUsdMicros);
    if (initial.status === "submitted") {
        return initial;
    }

    // Only retry if it's an insufficient equity error
    if (!isInsufficientEquityError(initial.error)) {
        return initial;
    }

    logger.info("Withdrawal failed due to insufficient equity, starting progressive retry", {
        vaultAddress,
        initialUsdMicros,
        initialUsd: initialUsdMicros / 1e6,
    });

    // Try progressively smaller amounts
    for (const pct of WITHDRAWAL_RETRY_PERCENTAGES) {
        const retryMicros = Math.floor(initialUsdMicros * pct);

        // Don't retry if amount is too small
        if (retryMicros < MIN_WITHDRAWAL_USD * 1e6) {
            logger.warn("Progressive retry reached minimum threshold", {
                vaultAddress,
                pct,
                retryUsd: retryMicros / 1e6,
            });
            break;
        }

        logger.info("Retrying withdrawal at reduced amount", {
            vaultAddress,
            pct: `${(pct * 100).toFixed(0)}%`,
            retryUsd: retryMicros / 1e6,
        });

        const retry = await attemptWithdrawal(vaultAddress, retryMicros);
        if (retry.status === "submitted") {
            logger.info("Progressive withdrawal succeeded", {
                vaultAddress,
                originalUsd: initialUsdMicros / 1e6,
                actualUsd: retryMicros / 1e6,
                successPct: `${(pct * 100).toFixed(0)}%`,
            });
            return { status: "submitted", actualUsdMicros: retryMicros };
        }

        // If it's not an insufficient equity error, stop retrying
        if (!isInsufficientEquityError(retry.error)) {
            return retry;
        }
    }

    // All retries failed
    logger.warn("Progressive withdrawal failed at all retry levels", {
        vaultAddress,
        initialUsd: initialUsdMicros / 1e6,
    });
    return { status: "error", error: "Insufficient equity even at 50% of reported value" };
}

function isInsufficientEquityError(message?: string): boolean {
    if (!message) return false;
    return message.toLowerCase().includes("insufficient vault equity");
}
