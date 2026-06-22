import {
    defaultExitConfig,
    shouldHardStop,
    shouldSoftStop,
    shouldIntraRoundSoftStop,
    shouldTrailingExit,
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
