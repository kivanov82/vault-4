// Pure helpers for settlement math. Kept isolated from VaultContractService so
// unit tests can exercise the arithmetic without pulling in viem / HL clients.

export type BridgeAmountInput = {
    pendingWithdraws: number; // shares (6-dec normalized to float)
    sharePrice: number; // USDC per share (18-dec PRECISION normalized to float)
    idleUsdc: number; // USDC already sitting in the contract
    l1Balance: number; // USDC available in the perps wallet to bridge over
};

export type BridgeAmountResult = {
    withdrawValueUsdc: number;
    shortfall: number;
    bridgeAmount: number;
    reason: "no-shortfall" | "no-l1-balance" | "ok";
};

/**
 * Computes the USDC amount the settlement pass should bridge from L1 to the
 * contract to satisfy pending share-withdrawals.
 *
 * Behavior:
 *  - withdrawValueUsdc = pendingWithdraws (shares) × sharePrice (USDC/share)
 *  - shortfall = max(0, withdrawValueUsdc − idleUsdc)
 *  - bridgeAmount = min(
 *        ceil(shortfall × 100) / 100,   // round UP to nearest cent (we'd
 *                                       //   rather over-fund than leave a
 *                                       //   pending withdraw short by a sub-
 *                                       //   cent rounding amount)
 *        floor(l1Balance × 100) / 100   // round DOWN — never claim more from
 *                                       //   L1 than is verifiably present
 *    )
 *
 * Returns 0 (with a reason) when shortfall is zero or L1 has nothing to send.
 */
export function computeBridgeAmount(input: BridgeAmountInput): BridgeAmountResult {
    const withdrawValueUsdc = input.pendingWithdraws * input.sharePrice;
    const rawShortfall = withdrawValueUsdc - input.idleUsdc;
    const shortfall = rawShortfall > 0 ? rawShortfall : 0;
    if (shortfall <= 0) {
        return {
            withdrawValueUsdc,
            shortfall: 0,
            bridgeAmount: 0,
            reason: "no-shortfall",
        };
    }
    const ceilShortfall = Math.ceil(shortfall * 100) / 100;
    const floorL1 = Math.floor(input.l1Balance * 100) / 100;
    const bridgeAmount = Math.min(ceilShortfall, floorL1);
    if (bridgeAmount <= 0) {
        return {
            withdrawValueUsdc,
            shortfall,
            bridgeAmount: 0,
            reason: "no-l1-balance",
        };
    }
    return {
        withdrawValueUsdc,
        shortfall,
        bridgeAmount,
        reason: "ok",
    };
}
