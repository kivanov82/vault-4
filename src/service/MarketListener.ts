import Taapi from "taapi";
import schedule from "node-schedule";
import {TICKER, TradingManager} from "./TradingManager";

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

const taapi = new Taapi("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjbHVlIjoiNjgxYTIxMDc4MDZmZjE2NTFlNWNiYmJlIiwiaWF0IjoxNzQ2NjI3OTU0LCJleHAiOjMzMjUxMDkxOTU0fQ.hXmdxDvWqHY1CbOLrPXVg1YjfPLNeIDcuiq8d7a7nto");
const aoThresholdTrendy = 150;


export class MarketListener {

    static async init(): Promise<any> {
        schedule.scheduleJob("1 * * * *", () => {
            this.getIndicators('1h').then((indicators) => {
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
                this.assertActionRequired(aoTrend, rsiMetrics);
            });
        })
    }

    static getIndicators(interval: string): Promise<any> {
        taapi.resetBulkConstructs();
        taapi.addCalculation("rsi", "BTC/USDT", interval, `rsi_${interval}`, {"results": 3});
        taapi.addCalculation("ao", "BTC/USDT", interval, `ao_${interval}`, {"results": 3});
        return taapi.executeBulk().then(results => {
            //console.log(results);
            return results;
        }).catch(error => {
            console.error(error)
        });
    }

    static assertActionRequired(aoTrend: AOTrend, rsiMetrics: RSIMetrics): void {
        console.log('AO Trend:', Object.entries(aoTrend).map(([key, value]) => `${key}=${value}`).join(', '));
        console.log('RSI Metrics:', Object.entries(rsiMetrics).map(([key, value]) => `${key}=${value}`).join(', '));
        if (aoTrend.reversalZero &&                                                     // AO crosses zero
            aoTrend.threshold > aoThresholdTrendy) {                                    // AO significant threshold
            if (rsiMetrics.bullSide == aoTrend.bullSide) {                              // RSI side same as AO side
                console.log('Action required: AO crosses zero with significant threshold AND AO side same as RSI side. ' +
                aoTrend.bullSide ? 'LONG' : 'SHORT');
                TradingManager.openOrder(TICKER.BTC, aoTrend.bullSide);
            } else {                                                                    // AO side not same as RSI side
                console.log('Action MAYBE required: AO crosses zero with significant threshold BUT AO side not same as RSI side. ' +
                aoTrend.bullSide ? 'LONG' : 'SHORT');
            }
        } else if (aoTrend.trendChange) {                                               // AO changes trend
            if (aoTrend.bullSide && aoTrend.bullTrend &&
                rsiMetrics.bullSide && !rsiMetrics.over) {                              //on a BULL side, change to BULL trend
                console.log('RETRACE: OPEN LONG');
                TradingManager.openOrder(TICKER.BTC, true);
            } else if (aoTrend.bullSide && !aoTrend.bullTrend) {                                    //on a BULL side, change to BEAR trend
                console.log('Action required: CLOSE LONG');
                TradingManager.marketCloseOrder(TICKER.BTC, true)
            } else if (!aoTrend.bullSide && !aoTrend.bullTrend &&
                !rsiMetrics.bullSide && !rsiMetrics.over) {                             //on a BEAR side, change to BEAR trend
                console.log('RETRACE: OPEN SHORT');
                TradingManager.openOrder(TICKER.BTC, false);
            } else if (!aoTrend.bullSide && aoTrend.bullTrend) {                                    //on a BULL side, change to BEAR trend
                console.log('Action required: CLOSE SHORT');
                TradingManager.marketCloseOrder(TICKER.BTC, false)
            }
        }
    }

}
