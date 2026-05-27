// Pure helpers for converting USD amounts to integer micros for Hyperliquid
// transfers. Kept isolated from RebalanceService so unit tests don't drag in
// the Hyperliquid SDK transitively via HyperliquidConnector.

export type DepositMicrosInput = {
    usdMicros?: number;
    amountUsd?: number;
};

export function toUsdMicros(amountUsd: number, bufferBps: number): number {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return 0;
    const buffered = amountUsd * (1 - bufferBps / 10000);
    return Math.max(0, Math.floor(buffered * 1e6));
}

export function toUsdMicrosFromDeposit(options: DepositMicrosInput): number {
    if (Number.isFinite(options.usdMicros)) {
        return Math.max(0, Math.floor(Number(options.usdMicros)));
    }
    if (Number.isFinite(options.amountUsd)) {
        return Math.max(0, Math.floor(Number(options.amountUsd) * 1e6));
    }
    return 0;
}
