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

    const primary = await attemptWithdrawal(equity.vaultAddress, targetMicros);
    if (primary.status === "submitted") {
        return {
            vaultAddress: equity.vaultAddress,
            equity: equity.equity,
            lockedUntilTimestamp: equity.lockedUntilTimestamp,
            usdMicros: targetMicros,
            status: "submitted",
        };
    }

    const shouldSweep =
        options.sweepDust &&
        options.usdBufferBps > 0 &&
        fullMicros > 0 &&
        fullMicros !== targetMicros &&
        isInsufficientEquityError(primary.error);
    if (!shouldSweep) {
        return {
            vaultAddress: equity.vaultAddress,
            equity: equity.equity,
            lockedUntilTimestamp: equity.lockedUntilTimestamp,
            usdMicros: targetMicros,
            status: "error",
            error: primary.error,
        };
    }

    const sweep = await attemptWithdrawal(equity.vaultAddress, fullMicros);
    if (sweep.status === "submitted") {
        return {
            vaultAddress: equity.vaultAddress,
            equity: equity.equity,
            lockedUntilTimestamp: equity.lockedUntilTimestamp,
            usdMicros: fullMicros,
            status: "submitted",
            reason: "sweep",
        };
    }

    return {
        vaultAddress: equity.vaultAddress,
        equity: equity.equity,
        lockedUntilTimestamp: equity.lockedUntilTimestamp,
        usdMicros: fullMicros,
        status: "error",
        error: sweep.error,
    };
}

async function attemptWithdrawal(
    vaultAddress: string,
    usdMicros: number
): Promise<{ status: "submitted" | "error"; error?: string }> {
    try {
        await HyperliquidConnector.vaultTransfer(
            vaultAddress as `0x${string}`,
            false,
            usdMicros
        );
        return { status: "submitted" };
    } catch (error: any) {
        const message = error?.message ?? String(error);
        logger.warn("Withdraw failed", { vaultAddress, message });
        return { status: "error", error: message };
    }
}

function isInsufficientEquityError(message?: string): boolean {
    if (!message) return false;
    return message.toLowerCase().includes("insufficient vault equity");
}
