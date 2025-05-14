import Taapi from "taapi";
import {TICKERS, HyperliquidConnector} from "./trade/HyperliquidConnector";
import dotenv from "dotenv";

dotenv.config(); // Load environment variables


export interface AOTrend {
    bullTrend: boolean,
    bullSide: boolean,
    threshold: number,
    trendChange: boolean,
    reversalZero: boolean,
    values: number[],
}

export interface RSIMetrics {
    bullSide: boolean,
    over: boolean,
    values: number[],
}

const taapi = new Taapi(process.env.TAAPI_SECRET);
const aoThresholdTrendy = 150;


export class MarketAdaptor {

    static scanMarkets(interval: string, ticker: string) {
        setTimeout(() => {
            taapi.resetBulkConstructs();
            taapi.addCalculation("rsi", `${ticker}/USDT`, interval, `rsi_${interval}`, {"results": 3});
            taapi.addCalculation("ao", `${ticker}/USDT`, interval, `ao_${interval}`, {"results": 3});
            taapi.executeBulk().then(indicators => {
                const ao = indicators.ao_1h.value;
                const rsi = indicators.rsi_1h.value;
                const aoTrend: AOTrend = {
                    bullTrend: ao[2] > ao[1],
                    bullSide: ao[2] > 0,
                    threshold: Math.abs(ao[2] - ((ao[1] + ao[0]) / 2)),
                    trendChange: (Math.abs(ao[1]) > Math.abs(ao[0]) && Math.abs(ao[2]) < Math.abs(ao[1])) ||
                        (Math.abs(ao[1]) < Math.abs(ao[0]) && Math.abs(ao[2]) > Math.abs(ao[1])),
                    reversalZero: ao[2] > 0 && ao[1] < 0 || ao[2] < 0 && ao[1] > 0,
                    values: ao,
                };
                const rsiMetrics: RSIMetrics = {
                    bullSide: Number(rsi[2]) > 50,
                    over: Number(rsi[2]) > 70 || Number(rsi[2]) < 30,
                    values: rsi,
                };
                this.assertActionRequired(aoTrend, rsiMetrics, ticker);
            }).catch(error => {
                console.error('Error when getting indicators, trying again in 20 seconds');
                this.scanMarkets(interval, ticker);
            });
        }, 20000);
    }

    static assertActionRequired(aoTrend: AOTrend, rsiMetrics: RSIMetrics, ticker: string): void {
        console.log(`${ticker}: AO Trend:`, Object.entries(aoTrend).map(([key, value]) => `${key}=${value}`).join(', '));
        console.log(`${ticker}: RSI Metrics:`, Object.entries(rsiMetrics).map(([key, value]) => `${key}=${value}`).join(', '));
        if (aoTrend.reversalZero &&                                                     // AO crosses zero
            aoTrend.threshold > aoThresholdTrendy) {                                    // AO significant threshold
            if (rsiMetrics.bullSide == aoTrend.bullSide) {                              // RSI side same as AO side
                console.log(`${ticker}: Action required: AO crosses zero with significant threshold AND AO side same as RSI side: ` + aoTrend.bullSide ? 'LONG' : 'SHORT');
                HyperliquidConnector.openOrder(TICKERS[ticker], aoTrend.bullSide);
            } else {                                                                    // AO side not same as RSI side
                console.log(`${ticker}: Action MAYBE required: AO crosses zero with significant threshold BUT AO side not same as RSI side: ` + aoTrend.bullSide ? 'LONG' : 'SHORT');
            }
        } else if (aoTrend.trendChange) {                                               // AO changes trend
            if (aoTrend.bullSide && aoTrend.bullTrend &&
                rsiMetrics.bullSide && !rsiMetrics.over) {                              //on a BULL side, change to BULL trend
                console.log(`${ticker}: RETRACE: OPEN LONG`);
                HyperliquidConnector.openOrder(TICKERS[ticker], true);
            } else if (aoTrend.bullSide && !aoTrend.bullTrend) {                                    //on a BULL side, change to BEAR trend
                console.log(`${ticker}: Action required: CLOSE LONG`);
                HyperliquidConnector.marketCloseOrder(TICKERS[ticker], true)
            } else if (!aoTrend.bullSide && !aoTrend.bullTrend &&
                !rsiMetrics.bullSide && !rsiMetrics.over) {                             //on a BEAR side, change to BEAR trend
                console.log(`${ticker}:RETRACE: OPEN SHORT`);
                HyperliquidConnector.openOrder(TICKERS[ticker], false);
            } else if (!aoTrend.bullSide && aoTrend.bullTrend) {                                    //on a BULL side, change to BEAR trend
                console.log(`${ticker}: Action required: CLOSE SHORT`);
                HyperliquidConnector.marketCloseOrder(TICKERS[ticker], false)
            }
        }
    }

}
