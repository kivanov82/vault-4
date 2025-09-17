export type Symbol = "BTC" | "ETH";

export interface IndicatorRow {
    time: string;   // ISO timestamp
    close: number;  // last price of the bar
    AO: number;     // Awesome Oscillator value
    RSI: number;    // 0..100
    SRSI: number;   // 0..100
}

export interface SignalResult {
    action: "buy" | "sell" | "hold";
    confidence: number; // 0..100
    debugLast10?: Record<string, any>; // optional: remove in prod
    debug?: Record<string, any>; // optional: remove in prod
}

/**
 * More sophisticated, deterministic model for 10x15m bars.
 * Works for BTC/ETH. Returns just "buy" or "sell" (+ confidence).
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

    const diff = (arr: number[]) => arr.map((v,i)=> i===0 ? NaN : v - arr[i-1]);
    const pct = (a: number, b: number) => (b === 0 ? 0 : (a/b - 1) * 100);

    // price returns (close-to-close)
    const rets = diff(closes).slice(1).map((d,i)=> d / closes[i+0]); // 8 values
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
    const prev = last10[8];

    // AO zero-cross (from last 4 bars)
    const aoZeroCrossUp =
        ao.slice(-4).some((v,i,a)=> i>0 && a[i-1] <= 0 && v > 0);
    const aoZeroCrossDown =
        ao.slice(-4).some((v,i,a)=> i>0 && a[i-1] >= 0 && v < 0);

    // Structure: higher highs / higher lows across 10 bars
    const highs = closes; // using close as proxy; swap in high[] if available
    const lows  = closes; // using close as proxy; swap in low[] if available
    let higherHighs = 0, higherLows = 0;
    for (let i = 1; i < 10; i++) {
        if (highs[i] > highs[i-1]) higherHighs++;
        if (lows[i]  > lows[i-1])  higherLows++;
    }

    // 3-bar momentum (more reactive)
    const mom3 = closes[9] - closes[6];

    // 10-bar realized volatility (annualization not needed; we want relative)
    const vol10 = stdev(rets); // ~stdev of returns

    // Tailored tolerances by symbol (ETH tends to be a bit more volatile)
    const symBoost = symbol === "ETH" ? 1.07 : 1.0;

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

    // 2) RSI regime (+ slope)
    const rsiVal = rsi[9];
    let rsiReg = 0;
    if (rsiVal >= 70) rsiReg = -24;        // overbought
    else if (rsiVal >= 60) rsiReg = -4;    // stretched
    else if (rsiVal >= 45 && rsiVal <= 60) rsiReg = 10; // healthy
    else if (rsiVal <= 30) rsiReg = 24;    // oversold bounce potential
    else rsiReg = 2;                       // neutral-ish

    feats.rsiReg = rsiReg;
    feats.rsiSlope = rsiSlope5 > 0 ? 6 : (rsiSlope5 < 0 ? -6 : 0);

    // 3) SRSI level + directional bias (crosses)
    const s = srsi[9];
    let srsiReg = 0;
    if (s >= 90) srsiReg = -24;            // very overbought
    else if (s >= 80) srsiReg = -14;
    else if (s <= 10) srsiReg = 24;        // very oversold
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
    const volZ = (vol10 / 0.004) * symBoost; // 0.4% stdev baseline per 15m (tweakable)
    let volAdj = 0;
    const volAdjAbovePerTicker: Record<Symbol, number> = { BTC: 16, ETH: 10 };
    const volAdjBelowPerTicker: Record<Symbol, number> = { BTC: 8, ETH: 6 };

    if (volZ > 1.6 && (rsiVal > 65 || s > 80)) volAdj -= volAdjAbovePerTicker[symbol];
    if (volZ > 1.6 && (rsiVal < 35 || s < 20)) volAdj += volAdjBelowPerTicker[symbol];
    feats.volAdj = volAdj;

    // Aggregate
    for (const k of Object.keys(feats)) score += feats[k];

    // ---------- convert score to decision ----------
    // Calibrated thresholds (conservative because TP/SL = +1% / -0.5% requires ~33% win-rate)
    // We require stronger evidence for BUY due to asymmetry (downs often faster).
    let action: "buy" | "sell" | "hold" = "hold";
    const buyLimitsPerTicker: Record<Symbol, number> = { BTC: 24, ETH: 18 };
    const sellLimitsPerTicker: Record<Symbol, number> = { BTC: -12, ETH: -5 };

    if (score >= buyLimitsPerTicker[symbol]) action = "buy";     // decent confluence
    if (score <= sellLimitsPerTicker[symbol]) action = "sell";   // default; bearish or weak confluence

    // Confidence mapping (0..100) with softclip
    const softclip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
    // Translate |score| into confidence; cap at 100
    const confidenceLoPerTicker: Record<Symbol, number> = { BTC: 55, ETH: 50 };
    const confidence = softclip(Math.round(50 + (Math.abs(score) / 80) * 50), confidenceLoPerTicker[symbol], 100);

    const result: SignalResult = {
        action,
        confidence,
        ...(opts?.returnDebug ? { debug: { score,
                feats: Object.entries(feats).map(([key, value]) => `${key}=${value}`).join(', '),
                aoLevel, aoSlope5, rsiVal,
                srsiVal: s,
                vol10, volZ, higherHighs, higherLows},
            debugLast10: Object.fromEntries(
                ["time", "close", "AO", "RSI", "SRSI"].map(col => [
                    col,
                    last10.map(row => String(row[col as keyof IndicatorRow])).join(",")
                ]))
        } : {})
    };

    return result;
}
