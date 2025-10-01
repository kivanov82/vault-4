import Taapi from "taapi";
import { getSignalH1, type IndicatorRow, type Symbol } from "../utils/smart-signal";
import {
    MIN_CONF_1H,
    REVERSAL_1H,
    RISK_1H,
} from "./execution-config";
import { HyperliquidConnector, TICKERS } from "../trade/HyperliquidConnector";
import { logger } from "../utils/logger";
import moment from "moment/moment";
import dotenv from "dotenv";

const TRADING_WALLET = process.env.WALLET as `0x${string}`;
dotenv.config(); // Load environment variables
const taapi = new Taapi(process.env.TAAPI_SECRET);

function fetchLast10H1(ticker: Symbol, interval: string): Promise<IndicatorRow[]> {
    taapi.resetBulkConstructs();
    taapi.addCalculation("rsi", `${ticker}/USDT`, interval, `rsi_${interval}`, {"results": 10});
    taapi.addCalculation("stochrsi", `${ticker}/USDT`, interval, `stochrsi_${interval}`, {"results": 10});
    taapi.addCalculation("ao", `${ticker}/USDT`, interval, `ao_${interval}`, {"results": 10});

    return HyperliquidConnector.candleSnapshot1h(ticker, 10).then((candles) => {
        return taapi.executeBulk().then(indicators => {
            // Process the data and update our data structure
            const rsiValues = indicators[`rsi_${interval}`].value;
            const stochRsiValues = indicators[`stochrsi_${interval}`].valueFastK;
            const aoValues = indicators[`ao_${interval}`].value;

            // Create data points from the API responses
            const newDataPoints: IndicatorRow[] = [];

            // Loop through up to 10 most recent candles
            for (let i = 0; i < Math.min(10, candles.length); i++) {
                const candle = candles[i];
                newDataPoints.push({
                    time: moment(candle.T).toISOString(),
                    close: parseFloat(candle.c),
                    AO: aoValues[i].toFixed(1),
                    RSI: rsiValues[i].toFixed(1),
                    SRSI: stochRsiValues[i].toFixed(1),
                });
            }
            return newDataPoints;
        }).catch(error => {
            logger.error('Error when getting indicators, trying again in 20 seconds');
            return fetchLast10H1(ticker, interval);
        });
    });
}

function sideFromAction(action: "buy" | "sell" | "hold"): "long" | "short" | "flat" {
    if (action === "buy") return "long";
    if (action === "sell") return "short";
    return "flat";
}

function positionSide(pos: any): "long" | "short" | "flat" {
    if (!pos) return "flat";
    return HyperliquidConnector.positionSide(pos); // your helper: 'long' | 'short'
}

function withinBp(a: number, b: number, maxBp: number): boolean {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    const drift = Math.abs((a / b - 1) * 10000); // basis points
    return drift <= maxBp;
}

// Optional: in-memory cooldown tracker
const lossStreak: Record<string, number> = {}; // key: `${symbol}:${side}`

function keySS(sym: Symbol, side: "long"|"short") { return `${sym}:${side}`; }

export async function runMainStrategy1h(symbols: Symbol[]) {
    for (const symbol of symbols) {
        try {
            const last10 = await fetchLast10H1(symbol, '1h');
            const signal = getSignalH1(symbol, last10, { returnDebug: true });

            // Hard parse guard
            if (!Number.isFinite(signal.confidence)) continue;

            const desiredSide = sideFromAction(signal.action);
            if (desiredSide === "flat") {
                logger.info(`[1H] ${symbol} holding: action=${signal.action}`);
                continue;
            }

            const minConf = MIN_CONF_1H[symbol][desiredSide];
            if (signal.confidence < minConf) {
                logger.info(`[1H] ${symbol} rejected: conf=${signal.confidence} < ${minConf}`);
                continue;
            }

            // Cooldown gating
            const streakKey = keySS(symbol, desiredSide);
            const extraScore = (lossStreak[streakKey] ?? 0) >= 2 ? RISK_1H.COOLDOWN_SCORE_BONUS : 0;
            const score = signal.debug?.score ?? 0;
            const buyLimitH1 = symbol === "BTC" ? 30 : 28;
            const sellLimitH1 = symbol === "BTC" ? -10 : -8;
            const passScore =
                desiredSide === "long" ? score >= (buyLimitH1 + extraScore)
                    : score <= (sellLimitH1 - extraScore);
            if (!passScore) {
                logger.info(`[1H] ${symbol} rejected by score cooldown gate. score=${score}, extra=${extraScore}`);
                continue;
            }

            // One-position rule
            const pos = await HyperliquidConnector.getOpenPosition(TRADING_WALLET, symbol);
            const posSide = positionSide(pos);

            // Reversal policy: only flip if close to entry and strong opposite evidence
            if (posSide !== "flat" && posSide !== desiredSide && REVERSAL_1H.ENABLED) {
                const lastPrice = last10[9].close;
                const entryPx = pos ? Number(pos.entryPx) : NaN;
                const oppositeScore = Math.abs(score); // simple: use magnitude as evidence
                // For clarity, you could compute an opposite-side re-score; using magnitude here conservatively
                const strong = (signal.confidence >= REVERSAL_1H.MIN_CONF) && (oppositeScore >= (Math.abs(score) + REVERSAL_1H.MIN_SCORE_DELTA));
                const nearEntry = withinBp(lastPrice, entryPx, REVERSAL_1H.MAX_ENTRY_DRIFT_BP);
                if (strong && nearEntry) {
                    logger.info(`[1H] ${symbol} reversal: ${posSide} -> ${desiredSide}, close & flip`);
                    await HyperliquidConnector.marketClosePosition(TICKERS[symbol], posSide === "long");
                    await HyperliquidConnector.openOrder(TICKERS[symbol], desiredSide === "long");
                    continue;
                } else {
                    // Hold existing; do not add
                    logger.info(`[1H] ${symbol} keep existing ${posSide}. Not flipping.`);
                    continue;
                }
            }

            // Already in same-side? Don't add.
            if (posSide === desiredSide) {
                logger.info(`[1H] ${symbol} already ${posSide}. Skip add.`);
                continue;
            }
            // Logging
            const dbg = {
                symbol, desiredSide,
                confidence: signal.confidence,
                score,
                volZ1h: signal.debug?.volZ1h,
                feats: signal.debug?.feats,
                ts: new Date().toISOString(),
            };
            logger.info(`[1H] OPENING ${symbol} ${desiredSide.toUpperCase()} conf=${signal.confidence} score=${score} json=${JSON.stringify(dbg)}`);

            // Open new position
            await HyperliquidConnector.openOrder(TICKERS[symbol], desiredSide === "long");

        } catch (e: any) {
            logger.error(`[1H] ${symbol} error: ${e?.message || String(e)}`);
        }
    }
}
