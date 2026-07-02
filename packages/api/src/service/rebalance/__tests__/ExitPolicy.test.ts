import {
    defaultExitConfig,
    isChopRegime,
    shouldHardStop,
    shouldSoftStop,
    shouldIntraRoundSoftStop,
    shouldTrailingExit,
    shouldTrim,
    trailingExitLevel,
    type ExitConfig,
} from "../ExitPolicy";

const config: ExitConfig = {
    stopLossPct: -15,
    hardStopLossPct: -25,
    minHoldDays: 5,
    notRecommendedRounds: 2,
    trailingArmRoePct: 10,
    trailingGivebackRatio: 0.5,
    trimMinRoePct: 0,
    trimOverweightTolerancePct: 25,
};

describe("defaultExitConfig", () => {
    it("returns the historical defaults when env vars are unset", () => {
        const cfg = defaultExitConfig();
        expect(cfg.stopLossPct).toBe(-15);
        expect(cfg.hardStopLossPct).toBe(-25);
        expect(cfg.minHoldDays).toBe(5);
        expect(cfg.notRecommendedRounds).toBe(2);
        expect(cfg.trailingArmRoePct).toBe(10);
        expect(cfg.trailingGivebackRatio).toBe(0.5);
        expect(cfg.trimMinRoePct).toBe(0);
        expect(cfg.trimOverweightTolerancePct).toBe(25);
    });

    it("honors env overrides", () => {
        process.env.HARD_STOP_LOSS_PCT = "-20";
        process.env.TRAILING_STOP_GIVEBACK_RATIO = "0.4";
        try {
            const cfg = defaultExitConfig();
            expect(cfg.hardStopLossPct).toBe(-20);
            expect(cfg.trailingGivebackRatio).toBe(0.4);
        } finally {
            delete process.env.HARD_STOP_LOSS_PCT;
            delete process.env.TRAILING_STOP_GIVEBACK_RATIO;
        }
    });

    it("ignores non-numeric env values", () => {
        process.env.STOP_LOSS_PCT = "banana";
        try {
            expect(defaultExitConfig().stopLossPct).toBe(-15);
        } finally {
            delete process.env.STOP_LOSS_PCT;
        }
    });
});

describe("shouldHardStop", () => {
    it("fires at and below the threshold", () => {
        expect(shouldHardStop(-25, config)).toBe(true);
        expect(shouldHardStop(-70.5, config)).toBe(true);
        expect(shouldHardStop(-24.9, config)).toBe(false);
        expect(shouldHardStop(0, config)).toBe(false);
    });
});

describe("shouldSoftStop", () => {
    it("fires below threshold when not recommended", () => {
        expect(shouldSoftStop(-16, false, true, config)).toBe(true);
    });

    it("fires below threshold when mis-aligned", () => {
        expect(shouldSoftStop(-16, true, false, config)).toBe(true);
    });

    it("holds below threshold when recommended and aligned", () => {
        expect(shouldSoftStop(-16, true, true, config)).toBe(false);
    });

    it("never fires above threshold", () => {
        expect(shouldSoftStop(-14.9, false, false, config)).toBe(false);
    });
});

describe("shouldIntraRoundSoftStop", () => {
    // Realist-Capital profile: abandoned, counter-regime, still falling.
    it("fires when below band, not recommended, mis-aligned, and deteriorating", () => {
        expect(shouldIntraRoundSoftStop(-18, -16, false, false, config)).toBe(true);
    });

    it("holds while still recommended (even if mis-aligned and falling)", () => {
        expect(shouldIntraRoundSoftStop(-18, -16, true, false, config)).toBe(false);
    });

    it("holds while regime-aligned (even if dropped and falling)", () => {
        expect(shouldIntraRoundSoftStop(-18, -16, false, true, config)).toBe(false);
    });

    it("holds a recovering position — spares the mean-reversion whipsaw", () => {
        // dipped to -20 last tick, bouncing back to -18: do not sell the bottom.
        expect(shouldIntraRoundSoftStop(-18, -20, false, false, config)).toBe(false);
    });

    it("never fires above the soft band", () => {
        expect(shouldIntraRoundSoftStop(-14.9, -10, false, false, config)).toBe(false);
    });

    it("never fires without a prior observation (first tick / fresh position)", () => {
        expect(shouldIntraRoundSoftStop(-18, null, false, false, config)).toBe(false);
    });
});

describe("trailing stop", () => {
    it("is unarmed below the arm threshold", () => {
        expect(trailingExitLevel(9.9, config)).toBeNull();
        expect(trailingExitLevel(null, config)).toBeNull();
        expect(shouldTrailingExit(-50, 9.9, config)).toBe(false);
    });

    it("arms at the threshold and fires at half the peak", () => {
        expect(trailingExitLevel(10, config)).toBe(5);
        expect(trailingExitLevel(20, config)).toBe(10);
        expect(shouldTrailingExit(5, 10, config)).toBe(true);
        expect(shouldTrailingExit(5.1, 10, config)).toBe(false);
        expect(shouldTrailingExit(9.9, 20, config)).toBe(true);
    });

    it("locks profit: exit level is always positive with giveback < 1", () => {
        for (const peak of [10, 14.3, 25, 80]) {
            const level = trailingExitLevel(peak, config);
            expect(level).not.toBeNull();
            expect(level as number).toBeGreaterThan(0);
        }
    });
});

describe("shouldTrim (profit-gated)", () => {
    it("trims a winner that is meaningfully over target", () => {
        // +30% over target, +8% ROE
        expect(shouldTrim(130, 100, 8, config)).toBe(true);
    });

    it("never trims below target or at target", () => {
        expect(shouldTrim(100, 100, 50, config)).toBe(false);
        expect(shouldTrim(90, 100, 50, config)).toBe(false);
    });

    it("holds an over-target LOSER — no realizing partial losses via trim", () => {
        expect(shouldTrim(130, 100, -3, config)).toBe(false);
        expect(shouldTrim(200, 100, -0.1, config)).toBe(false);
    });

    it("ignores small overweight drift inside the tolerance band", () => {
        // +24% over target: below the 25% tolerance
        expect(shouldTrim(124, 100, 10, config)).toBe(false);
        expect(shouldTrim(125, 100, 10, config)).toBe(true);
    });

    it("flat position (roe 0) with default gate 0 may be trimmed", () => {
        expect(shouldTrim(130, 100, 0, config)).toBe(true);
    });

    it("min-ROE gate is configurable", () => {
        const gated = { ...config, trimMinRoePct: 5 };
        expect(shouldTrim(130, 100, 4.9, gated)).toBe(false);
        expect(shouldTrim(130, 100, 5, gated)).toBe(true);
    });

    it("restoring old behavior: trimMinRoePct=-100 + tolerance 0 trims any excess", () => {
        const legacy = {
            ...config,
            trimMinRoePct: -100,
            trimOverweightTolerancePct: 0,
        };
        expect(shouldTrim(100.01, 100, -50, legacy)).toBe(true);
    });

    it("degenerate target (0) never trims — full exits belong to the withdrawal pass", () => {
        expect(shouldTrim(100, 0, 50, config)).toBe(false);
    });
});

describe("isChopRegime", () => {
    it("neutral direction is always chop", () => {
        expect(isChopRegime("neutral", "long")).toBe(true);
        expect(isChopRegime("neutral", "neutral")).toBe(true);
        expect(isChopRegime("neutral", null)).toBe(true);
    });

    it("direction flip is chop", () => {
        expect(isChopRegime("long", "short")).toBe(true);
        expect(isChopRegime("short", "long")).toBe(true);
        expect(isChopRegime("long", "neutral")).toBe(true);
    });

    it("confirmed trend is not chop", () => {
        expect(isChopRegime("long", "long")).toBe(false);
        expect(isChopRegime("short", "short")).toBe(false);
    });

    it("no history (first round / DB down) fails open — not chop", () => {
        expect(isChopRegime("long", null)).toBe(false);
        expect(isChopRegime("short", null)).toBe(false);
    });
});
