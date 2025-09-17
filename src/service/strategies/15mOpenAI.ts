import Taapi from "taapi";
import {TICKERS, HyperliquidConnector} from "../trade/HyperliquidConnector";
import dotenv from "dotenv";
import {Candle} from "@nktkas/hyperliquid";
import moment from "moment";
import {getSignal, IndicatorRow, SignalResult} from "../openAI/smart-signal";

dotenv.config(); // Load environment variables

const taapi = new Taapi(process.env.TAAPI_SECRET);

export class openAI {

  static scanMarkets(interval: string, ticker: string, delay: number) {
    setTimeout(() => {
      taapi.resetBulkConstructs();
      taapi.addCalculation("rsi", `${ticker}/USDT`, interval, `rsi_${interval}`, {"results": 10});
      taapi.addCalculation("stochrsi", `${ticker}/USDT`, interval, `stochrsi_${interval}`, {"results": 10});
      taapi.addCalculation("ao", `${ticker}/USDT`, interval, `ao_${interval}`, {"results": 10});

      HyperliquidConnector.candleSnapshot15Min(ticker, 10).then((candles: Candle[]) => {
        taapi.executeBulk().then(indicators => {
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
              time: moment(candle.T).format(),
              close: parseFloat(candle.c),
              AO: aoValues[i].toFixed(1),
              RSI: rsiValues[i].toFixed(1),
              SRSI: stochRsiValues[i].toFixed(1),
            });
          }
          // Debug output
          //console.log(this.formatDataPoints(newDataPoints));
          const result = getSignal(ticker as any, newDataPoints, {returnDebug: true});
          this.assertActionRequired(ticker, result);
        }).catch(error => {
          console.error('Error when getting indicators, trying again in 20 seconds');
          this.scanMarkets(interval, ticker, delay);
        });
      });
    }, delay);
  }

  // Method to format the data points as requested
  static formatDataPoints(newDataPoints : IndicatorRow[]): string {
    // Create header
    let output = "time,close,AO,RSI,SRSI\n";

    // Add each data point
    newDataPoints.forEach(point => {
      output += `${point.time},${point.close},${point.AO},${point.RSI},${point.SRSI}\n`;
    });

    return output;
  }

  static assertActionRequired(ticker: string, signal : SignalResult): void {
    console.log(`${ticker}:`,
        Object.entries(signal).map(([key, value]) => `${key}=${value}`).join(', '),
        Object.entries(signal.debug).map(([key, value]) => `${key}=${value}`).join(', '),
        Object.entries(signal.debugLast10).map(([key, value]) => `${key}=${value}`).join(', ')
        );
    if (signal.confidence > 60) {
      if (signal.action == 'sell') {                                    //on a BULL side, change to BEAR trend
        console.log(`${ticker}: Action required: OPEN SHORT`);
        HyperliquidConnector.openOrder(TICKERS[ticker], false);
      } else if (signal.action == 'buy') {                      //on a BEAR side, change to BULL trend
        console.log(`${ticker}: Action required: OPEN LONG`);
        HyperliquidConnector.openOrder(TICKERS[ticker], true);
      }
    }
  }
}
