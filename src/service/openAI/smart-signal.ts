// smart-signal.ts (full file with marked edits)

export type Symbol = "BTC" | "ETH";

export interface IndicatorRow {
    time: string;   // ISO timestamp
    close: number;  // last price of the bar
    AO: number;     // Awesome Oscillator value
    RSI: number;    // 0..100
    SRSI: number;   // 0..100
    high?: number;  // ★ NEW: optional true high for structure
    low?: number;   // ★ NEW: optional true low for structure
}

export interface SignalResult {
    action: "buy" | "sell" | "hold";
    confidence: number; // 0..100
    volZ: number,
    debugLast10?: Record<string, any>; // optional: remove in prod
    debug?: Record<string, any>;       // optional: remove in prod
}

// ---------- Stateful helpers (no signature changes) ----------

// ★ NEW: simple in-memory cool-down state per (symbol, "long"|"short")
type Dir = "long" | "short";
type Outcome = "win" | "loss";
const cooldownState = new Map<string, { until: number }>();
const keyCD = (sym: Symbol, dir: Dir) => `${sym}:${dir}`;

/**
 * ★ NEW: call this from your trade lifecycle when a trade closes.
 * Example: recordTradeOutcome("BTC", "long", "loss");
 * This starts a cool-down (stricter next BUY for a few checks).
 */
export function recordTradeOutcome(symbol: Symbol, dir: Dir, outcome: Outcome) {
    // Cool-down only after long losses (as per analysis); you can expand to shorts
    if (dir === "long" && outcome === "loss") {
        const now = Date.now();
        // keep stricter BUY for next ~2 checks; we use time-based TTL as a simple proxy (e.g., ~2 hours)
        cooldownState.set(keyCD(symbol, dir), { until: now + 2 * 60 * 60 * 1000 }); // 2h TTL
    }
}

/**
 * ★ NEW: check if long cool-down is active
 */
function longCooldownActive(symbol: Symbol) {
    const k = keyCD(symbol, "long");
    const rec = cooldownState.get(k);
    if (!rec) return false;
    if (Date.now() > rec.until) {
        cooldownState.delete(k);
        return false;
    }
    return true;
}

/**
 * ★ NEW: reversal guard helper (use outside getSignal if you like).
 * Only advise "reverse" near entry and for strong opposite scores.
 */
export function reversalGuard(params: {
    inPosition?: "long" | "short" | null;
    entryPrice?: number;
    lastPrice: number;
    action: "buy" | "sell" | "hold";
    score: number;
}) {
    const { inPosition, entryPrice, lastPrice, action, score } = params;
    if (!inPosition || !entryPrice) return "open" as "open" | "hold" | "reverse";

    const pnlPct = ((lastPrice / entryPrice) - 1) * (inPosition === "long" ? 100 : -100);
    const nearEntry = Math.abs(pnlPct) < 0.15; // ~±0.15% price ~ conservative for high leverage
    const strongOpp =
        (action === "buy" && score >= 25 && inPosition === "short") ||
        (action === "sell" && score <= -25 && inPosition === "long");

    if (strongOpp && nearEntry) return "reverse";
    return "hold";
}

// ------------------------------------------------------------

/**
 * More sophisticated, deterministic model for 10x15m bars.
 * Works for BTC/ETH. Returns just "buy"/"sell"/"hold" (+ confidence).
 */
export function getSignal(
    symbol: Symbol,
    last10: IndicatorRow[],
    opts?: { returnDebug?: boolean }
): SignalResult {
    if (!Array.isArray(last10) || last10.length !== 10) {
        throw new Error("Provide exactly 10 rows (15m bars).");
    }

    // ---------- helpers ----------
    const closes = last10.map(r => r.close);
    const ao = last10.map(r => r.AO);
    const rsi = last10.map(r => r.RSI);
    const srsi = last10.map(r => r.SRSI);

    // ★ NEW: prefer true highs/lows if provided; fallback to close proxy
    const highs = last10.every(r => typeof r.high === "number") ? last10.map(r => r.high as number) : closes;
    const lows  = last10.every(r => typeof r.low  === "number") ? last10.map(r => r.low  as number) : closes;

    const diff = (arr: number[]) => arr.map((v,i)=> i===0 ? NaN : v - arr[i-1]);
    // const pct = (a: number, b: number) => (b === 0 ? 0 : (a/b - 1) * 100); // ★ OPTIONAL: unused, remove if not needed

    // price returns (close-to-close)
    const rets = diff(closes).slice(1).map((d,i)=> d / closes[i]); // ★ CHANGED: // 9 values

    const mean = (a: number[]) => (a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0);
    const stdev = (a: number[]) => {
        if (!a.length) return 0;
        const m = mean(a);
        return Math.sqrt(mean(a.map(v => (v-m)**2)));
    };

    // recent slopes/changes
    const aoSlope5 = mean(diff(ao).slice(-5).filter(Number.isFinite));
    const rsiSlope5 = mean(diff(rsi).slice(-5).filter(Number.isFinite));
    const srsiSlope5 = mean(diff(srsi).slice(-5).filter(Number.isFinite));

    const last = last10[9];
    // const prev = last10[8]; // ★ OPTIONAL: unused, remove if not needed

    // AO zero-cross (from last 4 bars)
    const aoZeroCrossUp =
        ao.slice(-4).some((v,i,a)=> i>0 && a[i-1] <= 0 && v > 0);
    const aoZeroCrossDown =
        ao.slice(-4).some((v,i,a)=> i>0 && a[i-1] >= 0 && v < 0);

    // Structure: higher highs / higher lows across 10 bars
    let higherHighs = 0, higherLows = 0;
    for (let i = 1; i < 10; i++) {
        if (highs[i] > highs[i-1]) higherHighs++;
        if (lows[i]  > lows[i-1])  higherLows++;
    }

    // 3-bar momentum (more reactive)
    const mom3 = closes[9] - closes[6];

    // 10-bar realized volatility (annualization not needed; we want relative)
    const retsStd = stdev(rets);
    // ★ CHANGED: ETH baseline slightly higher to reflect typical 15m vol
    const volBaseline = symbol === "ETH" ? 0.0048 : 0.0040; // ETH > BTC
    const symBoost = symbol === "ETH" ? 1.07 : 1.0;
    const vol10 = retsStd;
    const volZ = (vol10 / volBaseline) * symBoost; // ★ CHANGED

    // ---------- feature scores (−100..+100) ----------
    let score = 0;
    const feats: Record<string, number> = {};

    // 1) Momentum / regime via AO
    const aoLevel = ao[9];
    const aoBull = aoLevel > 0 ? 1 : (aoLevel < 0 ? -1 : 0);
    const aoTrend = aoSlope5 > 0 ? 1 : (aoSlope5 < 0 ? -1 : 0);

    feats.aoRegime = 18 * aoBull;  // +18 bull above zero, −18 below zero
    feats.aoTrend  = 20 * aoTrend; // slope importance
    feats.aoCross  = aoZeroCrossUp ? 12 : (aoZeroCrossDown ? -12 : 0);

    // 2) RSI regime (+ slope)  // ★ already strengthened OB/OS
    const rsiVal = rsi[9];
    let rsiReg = 0;
    if (rsiVal >= 70) rsiReg = -24;        // overbought (stronger)
    else if (rsiVal >= 60) rsiReg = -4;    // stretched
    else if (rsiVal >= 45 && rsiVal <= 60) rsiReg = 10; // healthy
    else if (rsiVal <= 30) rsiReg = 24;    // oversold (stronger)
    else rsiReg = 2;                       // neutral-ish

    feats.rsiReg = rsiReg;
    feats.rsiSlope = rsiSlope5 > 0 ? 6 : (rsiSlope5 < 0 ? -6 : 0);

    // 3) SRSI level + directional bias (crosses) // ★ already strengthened OB/OS
    const s = srsi[9];
    let srsiReg = 0;
    if (s >= 90) srsiReg = -24;            // very overbought (stronger)
    else if (s >= 80) srsiReg = -14;
    else if (s <= 10) srsiReg = 24;        // very oversold (stronger)
    else if (s <= 20) srsiReg = 14;
    else if (s >= 40 && s <= 60) srsiReg = 6;  // mid rising often constructive
    else srsiReg = 2;

    const srsiTrend = srsiSlope5 > 0 ? 1 : (srsiSlope5 < 0 ? -1 : 0);
    feats.srsiReg   = srsiReg;
    feats.srsiTrend = 8 * srsiTrend;

    // 4) Structure & short momentum
    feats.structure = (higherHighs + higherLows - 9) * 1.8; // centered near 0
    feats.mom3      = mom3 > 0 ? 6 : (mom3 < 0 ? -6 : 0);

    // 5) Volatility sanity filter (don’t chase blow-offs)
    // If vol is unusually high AND srsi/RSI overbought, penalize longs; vice versa for oversold
    let volAdj = 0;
    const volAdjAbovePerTicker: Record<Symbol, number> = { BTC: 16, ETH: 10 };
    const volAdjBelowPerTicker: Record<Symbol, number> = { BTC: 8,  ETH: 6  };

    if (volZ > 1.6 && (rsiVal > 65 || s > 80)) volAdj -= volAdjAbovePerTicker[symbol];
    if (volZ > 1.6 && (rsiVal < 35 || s < 20)) volAdj += volAdjBelowPerTicker[symbol];
    feats.volAdj = volAdj;

    // Aggregate
    for (const k of Object.keys(feats)) score += feats[k];

    // ----- 40x BTC safety rail: avoid buying blow-off tops (OPTIONAL but recommended) -----
    const longVeto =
        symbol === "BTC" && (rsiVal >= 75 || s >= 90) && volZ > 1.2; // ★ NEW
    // (Optional) ETH long veto if ETH longs underperform for you:
    const ethLongVeto =
        symbol === "ETH" && (rsiVal >= 72 || s >= 88) && volZ > 1.3; // ★ NEW (can remove)

    // ---------- convert score to decision ----------
    // Calibrated thresholds (ticker-specific, stricter BUY for BTC 40×)
    let action: "buy" | "sell" | "hold" = "hold";
    // ★ CHANGED: pickier longs (larger BUY threshold), keep SELL thresholds
    const buyLimitsPerTicker: Record<Symbol, number>  = { BTC: 26, ETH: 22 }; // was {24,18}
    const sellLimitsPerTicker: Record<Symbol, number> = { BTC: -12, ETH: -5 };

    if (score >= buyLimitsPerTicker[symbol]) action = "buy";     // decent confluence
    if (score <= sellLimitsPerTicker[symbol]) action = "sell";   // bearish or weak confluence

    // Apply long vetoes (only if we were about to buy)
    if (action === "buy" && (longVeto || ethLongVeto)) action = "hold"; // ★ NEW

    // ★ NEW: Cool-down after long loss — enforce stricter BUY for 2h after a long loss
    if (action === "buy" && longCooldownActive(symbol)) {
        // require a surplus over the base BUY threshold to exit cooldown
        const surplus = 5; // need +5 score over base limit during cooldown
        if (score < buyLimitsPerTicker[symbol] + surplus) action = "hold";
    }

    // Confidence mapping (0..100) with softclip
    const softclip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
    const confidenceLoPerTicker: Record<Symbol, number> = { BTC: 55, ETH: 50 };
    const confidence = softclip(Math.round(50 + (Math.abs(score) / 80) * 50), confidenceLoPerTicker[symbol], 100);

    const result: SignalResult = {
        action,
        confidence,
        volZ,
        ...(opts?.returnDebug
            ? {
                debug: {
                    score,
                    feats: Object.fromEntries(Object.entries(feats)), // ★ CHANGED: structured map is easier to parse later
                    aoLevel, aoSlope5, rsiVal, srsiVal: s,
                    vol10, volZ, higherHighs, higherLows,
                    thresholds: { buy: buyLimitsPerTicker[symbol], sell: sellLimitsPerTicker[symbol] },
                    vetoes: { longVeto, ethLongVeto },
                    cooldownActive: longCooldownActive(symbol) // ★ NEW
                },
                debugLast10: Object.fromEntries(
                    ["time", "close", "AO", "RSI", "SRSI", "high", "low"].map(col => [
                        col,
                        last10.map(row => row[col as keyof IndicatorRow] as any)
                    ])
                )
            }
            : {})
    };

    return result;
}
