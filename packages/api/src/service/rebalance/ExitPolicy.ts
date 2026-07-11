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
    /**
     * Minimum ROE before an over-allocated recommended position may be
     * trimmed. The 5-month ledger showed avg win $8.38 vs avg loss $11.07 —
     * negative skew manufactured partly by trimming winners back to target
     * every round with no profit gate while losers ride to the stops. 0 means
     * "only trim positions in profit"; set to -100 to restore the old
     * unconditional behavior.
     */
    trimMinRoePct: number;
    /**
     * How far above target (as % of target) a position must be before a trim
     * fires. Mirrors REBALANCE_TOPUP_TOLERANCE_PCT on the deposit side so the
     * system stops clipping every small round-to-round allocation drift.
     */
    trimOverweightTolerancePct: number;
    /**
     * Rotation cost hurdle (STRATEGY-FORENSICS-2026-07 §5, the un-shipped
     * 2026-06 §7.5): a PROFITABLE non-recommended incumbent that has already
     * passed the hold period and the hysteresis streak is still only rotated
     * out when the best NEW deposit target out-scores it by this many stage-1
     * points. Claude's ranking is unstable round-to-round; without a margin,
     * ranking noise alone turned over >100% of the book in 10 days for
     * ~$0 per round trip. 0 disables (pre-hurdle behavior).
     */
    rotationScoreMargin: number;
    /**
     * Chop-brake deferral floor: during a chop round, non-recommended
     * positions with ROE at or above this level are held instead of rotated.
     * Was 0 (profitable-only), which meant mildly-underwater positions were
     * still sold at the bottom of exactly the regime the 2026-06 backtest
     * showed mean-reverts (round 38 realized −$22.6 on a chop day). −8 keeps
     * genuine losers (and all stop-losses) unaffected.
     */
    chopDeferMinRoePct: number;
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
        trimMinRoePct: envNumber("TRIM_MIN_ROE_PCT", 0),
        trimOverweightTolerancePct: envNumber(
            "TRIM_OVERWEIGHT_TOLERANCE_PCT",
            25
        ),
        rotationScoreMargin: envNumber("ROTATION_SCORE_MARGIN", 8),
        chopDeferMinRoePct: envNumber("CHOP_DEFER_MIN_ROE_PCT", -8),
    };
}

/**
 * Rotation cost hurdle for PROFITABLE incumbents (losing positions are risk
 * cleanup and never pass through here). Returns true when the rotation may
 * proceed.
 *
 * - `incumbentScore == null` → the incumbent wasn't scored this round (it
 *   fell out of the deterministic prefilter — TVL/age/DD deterioration).
 *   That is a genuine exit signal: allow.
 * - `challengerScore == null` → there is no scored NEW vault to rotate the
 *   freed capital into. Rotating out would just park cash: block.
 * - Otherwise the challenger must out-score the incumbent by the margin —
 *   the deterministic version of the prompt-level "beat the incumbent by
 *   > 0.5 robust-z" instruction, which Claude does not reliably honor.
 */
export function clearsRotationHurdle(
    incumbentScore: number | null,
    challengerScore: number | null,
    config: ExitConfig
): boolean {
    if (config.rotationScoreMargin <= 0) return true;
    if (incumbentScore == null) return true;
    if (challengerScore == null) return false;
    return challengerScore - incumbentScore >= config.rotationScoreMargin;
}

/**
 * Profit-gated trim decision for over-allocated recommended positions.
 * Fires only when the position is (a) actually over target by more than the
 * overweight tolerance and (b) at or above the minimum ROE — so trims harvest
 * winners instead of realizing partial losses, and small drift is left alone.
 */
export function shouldTrim(
    currentUsd: number,
    targetUsd: number,
    roePct: number,
    config: ExitConfig
): boolean {
    if (!(targetUsd > 0) || currentUsd <= targetUsd) return false;
    if (roePct < config.trimMinRoePct) return false;
    const overweightPct = ((currentUsd - targetUsd) / targetUsd) * 100;
    return overweightPct >= config.trimOverweightTolerancePct;
}

/**
 * Chop-regime detector for the deposit/rotation brake. The 5-month ledger
 * shows the strategy makes money in trends and gives it back in chop (Mar,
 * Jun 2026); the market-direction signal flip-flopping round-to-round is the
 * observable symptom. A round counts as "chop" when the current direction is
 * neutral (unreadable) or differs from the previous completed round's
 * direction (the signal just flipped — the new trend is unconfirmed).
 * `previousDirection == null` (first round, DB unavailable) is NOT chop:
 * fail-open so a trace-layer outage can't silently halve every deposit.
 */
export function isChopRegime(
    currentDirection: "long" | "short" | "neutral",
    previousDirection: "long" | "short" | "neutral" | null
): boolean {
    if (currentDirection === "neutral") return true;
    return previousDirection != null && previousDirection !== currentDirection;
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
 * Gated soft stop-loss for the intra-round RiskMonitor (4h cadence).
 *
 * The round-boundary soft stop (`shouldSoftStop`) only runs every 48h, which let
 * the 2026-06 Realist Capital position bleed from −15% to −22% (−$78 realized)
 * between two snapshots — its first sub-threshold observation *was* its exit, so
 * no threshold change in the backtest could recover it (see
 * STRATEGY-FORENSICS-2026-06.md §6). The cure is observing more often, not a
 * tighter number.
 *
 * But a *blanket* −15% check every 4h would whipsaw: the same backtest showed
 * that tightening the round-scan soft stop to −10/−12% LOST ~$67–91 by selling
 * positions that dipped into the soft band and recovered (Otter Quant, Overdose,
 * HODL My Perps all mean-reverted). So this intra-round variant is deliberately
 * far stricter than the round-scan version. It fires only when ALL hold:
 *   (a) ROE is in the soft band (≤ stopLossPct),
 *   (b) Claude has dropped the vault from the recommended set (!isRecommended),
 *   (c) the vault is trading against the regime (!isAligned),
 *   (d) ROE is still falling vs the previous tick (roePct < prevRoePct).
 *
 * (b)+(c) together (vs the round scan's `!rec || !aligned`) isolate the
 * Realist-Capital profile — an abandoned, counter-regime, confirmed-losing
 * position — while (d) spares a noisy oscillation that is bouncing back.
 * `prevRoePct == null` (first tick after boot, or a freshly-opened position)
 * never fires: we wait for a confirmed downward step.
 */
export function shouldIntraRoundSoftStop(
    roePct: number,
    prevRoePct: number | null,
    isRecommended: boolean,
    isAligned: boolean,
    config: ExitConfig
): boolean {
    if (roePct > config.stopLossPct) return false; // not in the soft band
    if (isRecommended || isAligned) return false; // require both abandoned AND misaligned
    if (prevRoePct == null) return false; // need a prior observation to confirm a trend
    return roePct < prevRoePct; // still deteriorating, not recovering
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
