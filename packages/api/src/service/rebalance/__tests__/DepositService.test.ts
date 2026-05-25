import { computeTopupTargets } from "../topup";
import type { VaultRecommendation } from "../../vaults/types";

// Minimal VaultRecommendation factory — only the fields computeTopupTargets reads.
const rec = (
    overrides: Partial<VaultRecommendation> & {
        vaultAddress: string;
        allocationPct: number;
    }
): VaultRecommendation =>
    ({
        name: overrides.vaultAddress.slice(-4),
        confidence: "high",
        reason: "",
        score: 0,
        metrics: {
            tvl: 0,
            weeklyPnl: 0,
            monthlyPnl: 0,
            allTimePnl: 0,
            ageDays: 0,
            followers: 0,
            tradesLast7d: 0,
        },
        ...overrides,
    }) as VaultRecommendation;

const baseInput = {
    highSelected: [] as VaultRecommendation[],
    lowSelected: [] as VaultRecommendation[],
    currentEquityMap: new Map<string, number>(),
    totalCapitalUsd: 1000,
    perpsBalanceUsd: 500,
    withdrawReserveUsd: 0,
    newSlotConsumed: 0,
    tolerancePct: 30,
    minDepositUsd: 5,
};

describe("computeTopupTargets", () => {
    test("tops up an underweight held vault to target", () => {
        // Claude wants 30% of $1000 = $300; we hold $100; want = $200; tolerance = max(5, 100*0.3)=$30; $200 > $30 → fire
        // Perps wallet $500 covers it fully → no scaling
        const result = computeTopupTargets({
            ...baseInput,
            highSelected: [rec({ vaultAddress: "0xAAA", allocationPct: 30 })],
            currentEquityMap: new Map([["0xaaa", 100]]),
        });
        expect(result.targets).toHaveLength(1);
        const t = result.targets[0];
        expect(t.kind).toBe("topup");
        expect(t.vaultAddress).toBe("0xAAA");
        expect(t.confidence).toBe("high");
        expect(t.targetUsd).toBe(300);
        expect(t.currentUsd).toBe(100);
        expect(t.desiredUsd).toBe(200);
        expect(t.depositUsd).toBe(200);
        expect(result.diagnostics.scaleFactor).toBe(1);
    });

    test("does not top up a vault already at or over its Claude target", () => {
        const result = computeTopupTargets({
            ...baseInput,
            highSelected: [rec({ vaultAddress: "0xAAA", allocationPct: 30 })],
            currentEquityMap: new Map([["0xaaa", 350]]), // over target
        });
        expect(result.targets).toHaveLength(0);
        // Over-target lands in skippedBelowTolerance because wantDeposit=0 < tolerance
        expect(result.diagnostics.skippedBelowTolerance).toHaveLength(1);
    });

    test("skips when underweight by less than the tolerance %", () => {
        // Target 30% = $300; current $260; want $40; tolerance = max(5, 260*0.3) = $78; $40 < $78 → skip
        const result = computeTopupTargets({
            ...baseInput,
            highSelected: [rec({ vaultAddress: "0xAAA", allocationPct: 30 })],
            currentEquityMap: new Map([["0xaaa", 260]]),
        });
        expect(result.targets).toHaveLength(0);
        expect(result.diagnostics.skippedBelowTolerance).toEqual([
            { vaultAddress: "0xAAA", wantDeposit: 40, tolerance: 78 },
        ]);
    });

    test("tolerance has an absolute $5 floor — fires even if 30% × current is tiny", () => {
        // Target 10% = $100; current $1; want $99; pct-tolerance = $0.30, but floored to $5; $99 > $5 → fire
        // Confirms a near-dust position still gets brought up to target.
        const result = computeTopupTargets({
            ...baseInput,
            highSelected: [rec({ vaultAddress: "0xAAA", allocationPct: 10 })],
            currentEquityMap: new Map([["0xaaa", 1]]),
        });
        expect(result.targets).toHaveLength(1);
        expect(result.targets[0].depositUsd).toBe(99);
    });

    test("the all-slots-full case: zero new deposits → full perps budget flows to topups", () => {
        // This is the bug fix from the code review: when newSlotConsumed=0 and the
        // perps wallet has cash, topups must access it directly (not via the
        // new-slot-capped availableForDeposit).
        const result = computeTopupTargets({
            ...baseInput,
            highSelected: [
                rec({ vaultAddress: "0xAAA", allocationPct: 10 }),
                rec({ vaultAddress: "0xBBB", allocationPct: 10 }),
            ],
            currentEquityMap: new Map([
                ["0xaaa", 50],
                ["0xbbb", 50],
            ]),
            perpsBalanceUsd: 100,
            newSlotConsumed: 0,
        });
        // Each wants $50; total $100; remaining budget $100 → scale=1
        expect(result.targets).toHaveLength(2);
        expect(result.targets.map((t) => t.depositUsd).sort()).toEqual([50, 50]);
        expect(result.diagnostics.scaleFactor).toBe(1);
    });

    test("scales topups proportionally when budget < total want", () => {
        // A wants $100, B wants $50; total want $150; budget $75 → scale = 0.5
        const result = computeTopupTargets({
            ...baseInput,
            highSelected: [
                rec({ vaultAddress: "0xAAA", allocationPct: 20 }),
                rec({ vaultAddress: "0xBBB", allocationPct: 10 }),
            ],
            currentEquityMap: new Map([
                ["0xaaa", 100], // target 200, want 100
                ["0xbbb", 50], // target 100, want 50
            ]),
            perpsBalanceUsd: 75,
        });
        expect(result.diagnostics.scaleFactor).toBeCloseTo(0.5, 5);
        const byAddr = new Map(result.targets.map((t) => [t.vaultAddress, t]));
        expect(byAddr.get("0xAAA")?.depositUsd).toBe(50);
        expect(byAddr.get("0xBBB")?.depositUsd).toBe(25);
    });

    test("drops topup whose post-scale deposit falls below minDepositUsd", () => {
        // A wants $100, B wants $20; budget = $12 → scale = 0.1
        // A scaled = $10 (≥ $5, kept), B scaled = $2 (< $5, dropped)
        const result = computeTopupTargets({
            ...baseInput,
            highSelected: [
                rec({ vaultAddress: "0xAAA", allocationPct: 20 }),
                rec({ vaultAddress: "0xBBB", allocationPct: 5 }),
            ],
            currentEquityMap: new Map([
                ["0xaaa", 100], // want 100
                ["0xbbb", 30], // want 20
            ]),
            perpsBalanceUsd: 12,
        });
        expect(result.targets).toHaveLength(1);
        expect(result.targets[0].vaultAddress).toBe("0xAAA");
        expect(result.targets[0].depositUsd).toBe(10);
    });

    test("new-slot consumption is subtracted from the perps budget first", () => {
        // perps $500, withdraw reserve $0, new slots already took $400 → topup budget $100
        const result = computeTopupTargets({
            ...baseInput,
            highSelected: [rec({ vaultAddress: "0xAAA", allocationPct: 30 })],
            currentEquityMap: new Map([["0xaaa", 100]]), // want $200
            perpsBalanceUsd: 500,
            newSlotConsumed: 400,
        });
        expect(result.diagnostics.remainingBudget).toBe(100);
        expect(result.targets[0].depositUsd).toBe(100); // scaled from $200 want
        expect(result.diagnostics.scaleFactor).toBe(0.5);
    });

    test("withdraw reserve is subtracted before topups can claim budget", () => {
        // perps $500, withdraw reserve $400 → effective budget $100
        const result = computeTopupTargets({
            ...baseInput,
            highSelected: [rec({ vaultAddress: "0xAAA", allocationPct: 30 })],
            currentEquityMap: new Map([["0xaaa", 100]]),
            perpsBalanceUsd: 500,
            withdrawReserveUsd: 400,
        });
        expect(result.diagnostics.remainingBudget).toBe(100);
        expect(result.targets[0].depositUsd).toBe(100);
    });

    test("empty perps budget produces zero topups even with eligible candidates", () => {
        const result = computeTopupTargets({
            ...baseInput,
            highSelected: [rec({ vaultAddress: "0xAAA", allocationPct: 30 })],
            currentEquityMap: new Map([["0xaaa", 100]]),
            perpsBalanceUsd: 0,
        });
        expect(result.targets).toHaveLength(0);
        expect(result.diagnostics.scaleFactor).toBe(0);
        // The candidate IS eligible — it's the budget that's zero, so it shouldn't show up
        // as "skipped below tolerance".
        expect(result.diagnostics.eligibleCount).toBe(1);
        expect(result.diagnostics.skippedBelowTolerance).toHaveLength(0);
    });

    test("vault not in highSelected/lowSelected is ignored even if held", () => {
        // A vault we hold but that dropped out of Claude's top-N this round
        // should NOT get topped up — the withdrawal pass will exit it instead.
        const result = computeTopupTargets({
            ...baseInput,
            highSelected: [rec({ vaultAddress: "0xAAA", allocationPct: 30 })],
            currentEquityMap: new Map([
                ["0xaaa", 100],
                ["0xbbb", 100], // held but not recommended
            ]),
        });
        expect(result.targets).toHaveLength(1);
        expect(result.targets[0].vaultAddress).toBe("0xAAA");
    });

    test("vault address matching is case-insensitive (recommendation may be mixed case)", () => {
        const result = computeTopupTargets({
            ...baseInput,
            highSelected: [rec({ vaultAddress: "0xAbCdEf", allocationPct: 30 })],
            currentEquityMap: new Map([["0xabcdef", 100]]), // lowercased key
        });
        expect(result.targets).toHaveLength(1);
        expect(result.targets[0].vaultAddress).toBe("0xAbCdEf");
    });

    test("vault with allocationPct=0 is silently skipped (not a 'below-tolerance' miss)", () => {
        const result = computeTopupTargets({
            ...baseInput,
            highSelected: [rec({ vaultAddress: "0xAAA", allocationPct: 0 })],
            currentEquityMap: new Map([["0xaaa", 100]]),
        });
        expect(result.targets).toHaveLength(0);
        expect(result.diagnostics.eligibleCount).toBe(0);
        expect(result.diagnostics.skippedBelowTolerance).toHaveLength(0);
    });

    test("confidence is preserved from the source list (high vs low)", () => {
        const result = computeTopupTargets({
            ...baseInput,
            highSelected: [rec({ vaultAddress: "0xAAA", allocationPct: 20 })],
            lowSelected: [rec({ vaultAddress: "0xBBB", allocationPct: 10 })],
            currentEquityMap: new Map([
                ["0xaaa", 100],
                ["0xbbb", 50],
            ]),
        });
        const byAddr = new Map(result.targets.map((t) => [t.vaultAddress, t]));
        expect(byAddr.get("0xAAA")?.confidence).toBe("high");
        expect(byAddr.get("0xBBB")?.confidence).toBe("low");
    });
});
