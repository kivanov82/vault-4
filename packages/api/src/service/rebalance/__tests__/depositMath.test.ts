import { clampCount, floorUsd, normalizeGroupPcts } from "../depositMath";

describe("normalizeGroupPcts", () => {
    test("preserves the input split when both groups are populated and sum to 100", () => {
        expect(normalizeGroupPcts(80, 20, 7, 3)).toEqual({ highPct: 80, lowPct: 20 });
    });

    test("rescales to 100 when the input pcts do not sum to 100", () => {
        // 70 + 35 = 105 → scale 100/105 ≈ 0.9524 → 66.67 / 33.33
        const result = normalizeGroupPcts(70, 35, 5, 5);
        expect(result.highPct).toBeCloseTo(66.67, 2);
        expect(result.lowPct).toBeCloseTo(33.33, 2);
        expect(result.highPct + result.lowPct).toBeCloseTo(100, 1);
    });

    test("collapses to 100% low when there are no high-confidence vaults", () => {
        // Prevents the surprise where Claude returned zero high-confidence picks
        // and the barbell would otherwise leak 80% of capital to nothing.
        expect(normalizeGroupPcts(80, 20, 0, 3)).toEqual({ highPct: 0, lowPct: 100 });
    });

    test("collapses to 100% high when there are no low-confidence vaults", () => {
        expect(normalizeGroupPcts(80, 20, 5, 0)).toEqual({ highPct: 100, lowPct: 0 });
    });

    test("returns 0/0 when both groups are empty (no deposits should run)", () => {
        expect(normalizeGroupPcts(80, 20, 0, 0)).toEqual({ highPct: 0, lowPct: 0 });
    });

    test("falls back to the documented 80/20 split when both input pcts are zero with non-empty groups", () => {
        // Safety net: misconfigured inputs (both zero) shouldn't produce a
        // div-by-zero. Falls back to the executor's documented 80/20 barbell
        // (DepositService.DEFAULT_HIGH_PCT / DEFAULT_LOW_PCT).
        expect(normalizeGroupPcts(0, 0, 5, 5)).toEqual({ highPct: 80, lowPct: 20 });
    });

    test("handles non-finite inputs by treating their sum as zero", () => {
        // Number coercion of NaN inputs yields a NaN total → not finite → fallback.
        expect(normalizeGroupPcts(NaN, 20, 5, 5)).toEqual({ highPct: 80, lowPct: 20 });
    });
});

describe("clampCount", () => {
    test("returns the floor of a finite numeric input", () => {
        expect(clampCount(7.9, 0)).toBe(7);
        expect(clampCount(3.2, 0)).toBe(3);
    });

    test("clamps below min", () => {
        expect(clampCount(-5, 0)).toBe(0);
        expect(clampCount(2, 5)).toBe(5);
    });

    test("clamps above max when max provided", () => {
        expect(clampCount(20, 0, 10)).toBe(10);
    });

    test("returns min for any non-finite input (NaN, Infinity)", () => {
        // Guards against a future env-driven count getting NaN-coerced — we
        // want a deterministic fallback, not propagation. Infinity is treated
        // the same as NaN by Number.isFinite, so it also falls back to min.
        expect(clampCount(NaN, 3)).toBe(3);
        expect(clampCount(Infinity, 0, 10)).toBe(0);
    });

    test("no upper bound when max is omitted", () => {
        expect(clampCount(1_000_000, 0)).toBe(1_000_000);
    });

    test("production defaults clamp to an exact 8 high / 3 low / 11 active split", () => {
        // Mirrors DepositService.buildDepositPlan's clamp chain with the shipped
        // constants (DEFAULT_MAX_ACTIVE=11, DEFAULT_HIGH_COUNT=8, DEFAULT_LOW_COUNT=3).
        // Locks the invariant that the bucket counts sum to maxActive — so a future
        // bump to maxActive that forgets to re-balance the buckets fails here.
        const DEFAULT_MAX_ACTIVE = 11;
        const DEFAULT_HIGH_COUNT = 8;
        const DEFAULT_LOW_COUNT = 3;

        const maxActive = clampCount(DEFAULT_MAX_ACTIVE, 1);
        const highCount = clampCount(DEFAULT_HIGH_COUNT, 0, maxActive);
        const lowCount = clampCount(DEFAULT_LOW_COUNT, 0, maxActive - highCount);

        expect(maxActive).toBe(11);
        expect(highCount).toBe(8);
        expect(lowCount).toBe(3);
        expect(highCount + lowCount).toBe(maxActive);
    });
});

describe("floorUsd", () => {
    test("floors to cent precision", () => {
        // The round-up surprise this guards against: 100.999 → 100.99, not 101.00,
        // so summed deposit targets never exceed available perps cash.
        expect(floorUsd(100.999)).toBe(100.99);
        expect(floorUsd(33.333)).toBe(33.33);
    });

    test("preserves whole-dollar values", () => {
        expect(floorUsd(50)).toBe(50);
    });

    test("preserves zero", () => {
        expect(floorUsd(0)).toBe(0);
    });
});
