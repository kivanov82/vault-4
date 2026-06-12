/**
 * Exit-policy thresholds and pure decision helpers, shared by:
 *  - RebalanceOrchestrator (round-boundary withdrawal scan)
 *  - RiskMonitor (intra-round hard-SL / trailing-stop checks)
 *  - scripts/backtest.ts (decision-logic replay over the trace history)
 *
 * Keeping the decision math here pure (no I/O) is what makes the backtest a
 * faithful replay — it runs the same functions the live system runs.
 */

export type ExitConfig = {
    /** Soft stop-loss: exit at this ROE if not recommended or mis-aligned. */
    stopLossPct: number;
    /** Hard stop-loss: exit at this ROE unconditionally. */
    hardStopLossPct: number;
    /** Minimum days since last deposit before non-recommended rotation. */
    minHoldDays: number;
    /**
     * Consecutive rounds a vault must be non-recommended before rotating out.
     * 1 reproduces the pre-hysteresis behavior (exit on first non-recommended
     * round past the hold period); 2 gives Claude's ranking variance one round
     * to self-correct before we pay the exit/re-entry round trip.
     */
    notRecommendedRounds: number;
    /** Trailing stop arms once peak ROE reaches this level. */
    trailingArmRoePct: number;
    /** Fraction of peak ROE given back before the trailing stop fires. */
    trailingGivebackRatio: number;
};

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null || raw === "") return fallback;
    const num = Number(raw);
    return Number.isFinite(num) ? num : fallback;
}

export function defaultExitConfig(): ExitConfig {
    return {
        stopLossPct: envNumber("STOP_LOSS_PCT", -15),
        hardStopLossPct: envNumber("HARD_STOP_LOSS_PCT", -25),
        minHoldDays: envNumber("MIN_HOLD_DAYS", 5),
        notRecommendedRounds: envNumber("NOT_RECOMMENDED_EXIT_ROUNDS", 2),
        trailingArmRoePct: envNumber("TRAILING_STOP_ARM_ROE_PCT", 10),
        trailingGivebackRatio: envNumber("TRAILING_STOP_GIVEBACK_RATIO", 0.5),
    };
}

export function shouldHardStop(roePct: number, config: ExitConfig): boolean {
    return roePct <= config.hardStopLossPct;
}

export function shouldSoftStop(
    roePct: number,
    isRecommended: boolean,
    isAligned: boolean,
    config: ExitConfig
): boolean {
    return roePct <= config.stopLossPct && (!isRecommended || !isAligned);
}

/**
 * ROE level at which the trailing stop fires, or null while unarmed.
 * The trigger level is peak × (1 − giveback), so with the defaults (arm 10,
 * giveback 0.5) it always sits in profit (≥ +5%). The realized exit ROE can
 * land below the trigger when the giveback blows past it between
 * observations — the RiskMonitor's intra-round cadence bounds that slippage.
 */
export function trailingExitLevel(
    peakRoePct: number | null,
    config: ExitConfig
): number | null {
    if (peakRoePct == null || peakRoePct < config.trailingArmRoePct) return null;
    return peakRoePct * (1 - config.trailingGivebackRatio);
}

export function shouldTrailingExit(
    roePct: number,
    peakRoePct: number | null,
    config: ExitConfig
): boolean {
    const level = trailingExitLevel(peakRoePct, config);
    return level != null && roePct <= level;
}
