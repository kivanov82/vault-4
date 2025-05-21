import Taapi from "taapi";
import {TICKERS, HyperliquidConnector} from "./trade/HyperliquidConnector";
import dotenv from "dotenv";

dotenv.config(); // Load environment variables

const WALLET = process.env.WALLET as `0x${string}`;


export interface AOTrend {
    bullTrend: boolean,
    bullSide: boolean,
    trendChange: 'no' | 'suddenSwift' | 'twoStick',
    values: number[],
    closeToZero: boolean,
    crossingZero: boolean
}

export interface RSIMetrics {
    bullSide: boolean,
    over: boolean,
    values: number[],
}

const taapi = new Taapi(process.env.TAAPI_SECRET);


export class MarketAdaptor {

    static scanMarkets(interval: string, ticker: string, delay: number) {
        setTimeout(() => {
            taapi.resetBulkConstructs();
            taapi.addCalculation("rsi", `${ticker}/USDT`, interval, `rsi_${interval}`, {"results": 3});
            taapi.addCalculation("ao", `${ticker}/USDT`, interval, `ao_${interval}`, {"results": 4});
            HyperliquidConnector.getMarket(ticker).then(market => {
                taapi.executeBulk().then(indicators => {
                    const ao = indicators.ao_1h.value;
                    const rsi = indicators.rsi_1h.value;
                    const aoTrend: AOTrend = {
                        bullTrend: ao[3] > ao[2],
                        bullSide: ao[3] > 0,
                        trendChange: this.trendChanged(ao),                                             //for trend changed
                        closeToZero: Math.abs(ao[3]) < market / 1000,                                    //for trend changed

                        crossingZero: this.crossingZeroDecision(ao),                                     //for crossing zero
                        values: ao
                    };
                    const rsiMetrics: RSIMetrics = {
                        bullSide: Number(rsi[2]) > 50,
                        over: Number(rsi[2]) > 70 || Number(rsi[2]) < 30,
                        values: rsi,
                    };
                    this.assertActionRequired(aoTrend, rsiMetrics, ticker);
                }).catch(error => {
                    console.error('Error when getting indicators, trying again in 20 seconds');
                    this.scanMarkets(interval, ticker, delay);
                });
            })
        }, delay);
    }

    static assertActionRequired(aoTrend: AOTrend, rsiMetrics: RSIMetrics, ticker: string): void {
        console.log(`${ticker}: AO Trend:`, Object.entries(aoTrend).map(([key, value]) => `${key}=${value}`).join(', '));
        console.log(`${ticker}: RSI Metrics:`, Object.entries(rsiMetrics).map(([key, value]) => `${key}=${value}`).join(', '));
        if (aoTrend.crossingZero) {                             // AO is (about) crossing zero
            if (rsiMetrics.bullSide === aoTrend.bullTrend) {                                         // RSI side same as AO trend
                console.log(`${ticker}: Action required: AO is about (or crossing) zero AND AO side same as RSI side`);
                HyperliquidConnector.openOrder(TICKERS[ticker], aoTrend.bullTrend);
            } else {                                                                                        // AO side not same as RSI side
                console.log(`${ticker}: Action MAYBE required: AO is about (or crossing) zero BUT AO side NOT same as RSI side`);
            }
        } else if (aoTrend.trendChange != 'no'  && !aoTrend.closeToZero) {                        // AO changes trend
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
        } else {
            HyperliquidConnector.getOpenPosition(WALLET, ticker).then(position => {
                if (position) {
                    HyperliquidConnector.considerTakingProfit(position)
                }
            });
        }
    }

    static trendChanged(ao: any[]) {
        const lastDeviation = Math.abs(ao[2] - ao[1]);
        const currentDeviation = Math.abs(ao[3] - ao[2]);
        if (currentDeviation > lastDeviation &&                      //the threshold is higher than before ...
            ((ao[2] > ao[1] && ao[3] < ao[2]) ||                                             //... and the opposite side
                (ao[2] < ao[1] && ao[3] > ao[2]))) {
            return 'suddenSwift';
        } else if ((ao[3] < ao[2] && ao[2] < ao[1] && ao[1] > ao[0]) ||                                             //... and the opposite side
            (ao[3] > ao[2] && ao[2] > ao[1] && ao[1] < ao[0])) {
            return 'twoStick';
        } else {
            return 'no';
        }
    }

    static crossingZeroDecision(ao: any[]) {
        const bullDirection = ao[3] > ao[2];            //detect latest direction
        if (bullDirection) {
            //crossed already?
            if (ao[3] > 0 && ao[2] < 0) {
                return true;
            } else if (ao[3] < 0){
                //would cross zero next?
                const lastMove = Math.abs(ao[3] - ao[2]);
                return ao[3] + lastMove > 0;
            } else {
                return false;
            }
        } else {
            //crossed already?
            if (ao[3] < 0 && ao[2] > 0) {
                return true;
            } else if (ao[3] > 0){
                //would cross zero next?
                const lastMove = Math.abs(ao[3] - ao[2]);
                return ao[3] - lastMove < 0;
            } else {
                return false;
            }
        }
    }


}
