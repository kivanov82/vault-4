export const tpSl = {
    BTC: { long: { tp: 20, sl: 10 }, short: { tp: 22, sl: 12 } },
    ETH: { long: { tp: 34, sl: 10 }, short: { tp: 20, sl: 12 } },
} as const;

export const singleOrderSize = 0.3;
export const takeProfitSize = 100;  // %


// Confidence minimums (executor-side, extra safety)
export const MIN_CONF_1H = {
    BTC: { long: 62, short: 60 },
    ETH: { long: 60, short: 58 },
} as const;

// Reversal policy for H1: only near-entry and strong confluence
export const REVERSAL_1H = {
    ENABLED: true,
    MIN_CONF: 80,
    MIN_SCORE_DELTA: 12,     // opposite score must beat current by ≥ 12
    MAX_ENTRY_DRIFT_BP: 15,  // 0.15% distance from entry
};

// Risk policy (executor decides TP/SL/hold-time if you want it here)
export const RISK_1H = {
    ONE_POSITION_PER_SYMBOL: true,
    COOLDOWN_AFTER_2_LOSSES_HOURS: 72,
    COOLDOWN_SCORE_BONUS: 5,  // require +5 score during cooldown
    VOLZ_HOT: 1.6,            // used for logging / optional sizing
};
