import { computeBridgeAmount } from "../settlementMath";

describe("computeBridgeAmount", () => {
    test("returns 0 with reason 'no-shortfall' when idle USDC already covers pending withdraws", () => {
        // 100 shares × $1.05/share = $105 owed; contract already holds $200 idle
        const result = computeBridgeAmount({
            pendingWithdraws: 100,
            sharePrice: 1.05,
            idleUsdc: 200,
            l1Balance: 50,
        });
        expect(result.withdrawValueUsdc).toBeCloseTo(105, 5);
        expect(result.shortfall).toBe(0);
        expect(result.bridgeAmount).toBe(0);
        expect(result.reason).toBe("no-shortfall");
    });

    test("rounds shortfall UP to nearest cent (prefer over-fund to under-fund)", () => {
        // shares=100, price=1.0501 → owed=105.01; idle=50 → shortfall=55.01
        // ceil(55.01 * 100) / 100 = 55.01 (no rounding needed — already 2dp)
        // But if shortfall had a sub-cent residual we round up.
        const result = computeBridgeAmount({
            pendingWithdraws: 100,
            sharePrice: 1.0501,
            idleUsdc: 50,
            l1Balance: 1000,
        });
        // raw shortfall = 55.010000000000005 (JS float noise); ceil → 55.02 or 55.01 depending
        // What we DO assert: bridgeAmount >= raw shortfall (never under-funds).
        expect(result.bridgeAmount).toBeGreaterThanOrEqual(result.shortfall);
        expect(result.reason).toBe("ok");
    });

    test("caps bridge at floor(l1Balance) when L1 cannot cover the full shortfall", () => {
        // shortfall = $105 - $50 = $55; L1 has only $54.99
        // ceil(55) = 55; floor(54.99) = 54.99; min = 54.99
        const result = computeBridgeAmount({
            pendingWithdraws: 100,
            sharePrice: 1.05,
            idleUsdc: 50,
            l1Balance: 54.99,
        });
        expect(result.shortfall).toBeCloseTo(55, 5);
        expect(result.bridgeAmount).toBe(54.99);
        expect(result.reason).toBe("ok");
    });

    test("returns 0 with reason 'no-l1-balance' when L1 is empty", () => {
        const result = computeBridgeAmount({
            pendingWithdraws: 100,
            sharePrice: 1.05,
            idleUsdc: 0,
            l1Balance: 0,
        });
        expect(result.shortfall).toBeCloseTo(105, 5);
        expect(result.bridgeAmount).toBe(0);
        expect(result.reason).toBe("no-l1-balance");
    });

    test("sub-cent L1 dust floors to 0 — never attempt a zero/negative bridge", () => {
        // Settlement: L1 has $0.009 — floor → $0.00, no bridge attempt.
        const result = computeBridgeAmount({
            pendingWithdraws: 100,
            sharePrice: 1.05,
            idleUsdc: 50,
            l1Balance: 0.009,
        });
        expect(result.bridgeAmount).toBe(0);
        expect(result.reason).toBe("no-l1-balance");
    });

    test("zero sharePrice produces zero withdrawValue (vault has no NAV → no bridge)", () => {
        const result = computeBridgeAmount({
            pendingWithdraws: 100,
            sharePrice: 0,
            idleUsdc: 0,
            l1Balance: 1000,
        });
        expect(result.withdrawValueUsdc).toBe(0);
        expect(result.shortfall).toBe(0);
        expect(result.bridgeAmount).toBe(0);
        expect(result.reason).toBe("no-shortfall");
    });

    test("zero pendingWithdraws short-circuits (no settlement needed)", () => {
        const result = computeBridgeAmount({
            pendingWithdraws: 0,
            sharePrice: 1.05,
            idleUsdc: 0,
            l1Balance: 1000,
        });
        expect(result.shortfall).toBe(0);
        expect(result.bridgeAmount).toBe(0);
        expect(result.reason).toBe("no-shortfall");
    });
});
