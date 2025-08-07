import Taapi from "taapi";
import {TICKERS, HyperliquidConnector} from "../trade/HyperliquidConnector";
import dotenv from "dotenv";

dotenv.config(); // Load environment variables

const WALLET = process.env.WALLET as `0x${string}`;


export interface AOTrend {
    bullTrend: boolean,
    bullSide: boolean,
    trendChange: true | false,
    values: number[],
    closeToZero: boolean
}

const taapi = new Taapi(process.env.TAAPI_SECRET);


export class fifteenMinAOChange {

    static scanMarkets(interval: string, ticker: string, delay: number) {
        setTimeout(() => {
            taapi.resetBulkConstructs();
            taapi.addCalculation("ao", `${ticker}/USDT`, interval, `ao_${interval}`, {"results": 4});
            HyperliquidConnector.getMarket(ticker).then(market => {
                taapi.executeBulk().then(indicators => {
                    const ao = indicators.ao_15m.value;
                    const aoTrend: AOTrend = {
                        bullTrend: ao[3] > ao[2],
                        bullSide: ao[3] > 0,
                        trendChange: this.trendChanged(ao),                                             //for trend changed
                        closeToZero: Math.abs(ao[3]) < market / 300,                                    //around zero
                        values: ao
                    };
                    this.assertActionRequired(aoTrend, ticker);
                }).catch(error => {
                    console.error('Error when getting indicators, trying again in 20 seconds');
                    this.scanMarkets(interval, ticker, delay);
                });
            })
        }, delay);
    }

    static assertActionRequired(aoTrend: AOTrend, ticker: string): void {
        console.log(`${ticker}: AO Trend:`, Object.entries(aoTrend).map(([key, value]) => `${key}=${value}`).join(', '));
        if (aoTrend.trendChange  && !aoTrend.closeToZero) {                          // AO changes trend
            if (aoTrend.bullSide && !aoTrend.bullTrend) {                                    //on a BULL side, change to BEAR trend
                console.log(`${ticker}: Action required: OPEN SHORT`);
                HyperliquidConnector.openOrder(TICKERS[ticker], false);
            } else if (!aoTrend.bullSide && aoTrend.bullTrend) {                                    //on a BEAR side, change to BULL trend
                console.log(`${ticker}: Action required: OPEN LONG`);
                HyperliquidConnector.openOrder(TICKERS[ticker], true);
            }
        }
    }

    static trendChanged(ao: any[]) {
        const bullDirection = ao[3] > ao[2];
        return ((ao[2] > ao[1] && !bullDirection) ||                                            //opposite direction now
            (ao[2] < ao[1] && bullDirection))
    }


}
