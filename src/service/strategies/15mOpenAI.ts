import Taapi from "taapi";
import {TICKERS, HyperliquidConnector} from "../trade/HyperliquidConnector";
import dotenv from "dotenv";
import moment from "moment";
import {getSignal, IndicatorRow, recordTradeOutcome, reversalGuard, SignalResult} from "../openAI/smart-signal";
import * as hl from "@nktkas/hyperliquid";

const TRADING_WALLET = process.env.WALLET as `0x${string}`;

dotenv.config(); // Load environment variables

const taapi = new Taapi(process.env.TAAPI_SECRET);

export class openAI {

  static subscribeToEvents() {
    const transport = new hl.WebSocketTransport();
    const client = new hl.SubscriptionClient({ transport });
    transport.socket.addEventListener("open", () => {
      console.log("COPY TRADING: Connection opened.");
    });
    client.userFills({ user: TRADING_WALLET }, (data) => {
      data.fills.forEach(fill => {
        if(fill.time >= Date.now() - 10 * 60 * 1000 &&
            (fill.dir === 'Close Short' || fill.dir === 'Close Long') &&
            Number(fill.closedPnl) < 0) {
          console.log(`Position closed with loss, adjusting strategy for ${fill.coin}`);
          recordTradeOutcome(fill.coin as any,
              fill.side === 'B' ? 'short' : 'long',       //short (long) was closed in the opposite direction
              'loss');
        }
      })
    });
  }
  static scanMarkets(interval: string, ticker: string, delay: number) {
    setTimeout(() => {
      taapi.resetBulkConstructs();
      taapi.addCalculation("rsi", `${ticker}/USDT`, interval, `rsi_${interval}`, {"results": 10});
      taapi.addCalculation("stochrsi", `${ticker}/USDT`, interval, `stochrsi_${interval}`, {"results": 10});
      taapi.addCalculation("ao", `${ticker}/USDT`, interval, `ao_${interval}`, {"results": 10});

      HyperliquidConnector.candleSnapshot15Min(ticker, 10).then((candles) => {
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
          const result = getSignal(ticker as any, newDataPoints, {returnDebug: true});
          this.assertActionRequired(ticker, result, newDataPoints[newDataPoints.length -1]);
        }).catch(error => {
          console.error('Error when getting indicators, trying again in 20 seconds');
          this.scanMarkets(interval, ticker, delay);
        });
      });
    }, delay);
  }

  static async assertActionRequired(ticker: string, signal: SignalResult, lastIndicator: IndicatorRow) {
    console.log(`${ticker}:`,
        Object.entries(signal).map(([key, value]) => `${key}=${value}`).join(', '),
        Object.entries(signal.debug).map(([key, value]) => `${key}=${value}`).join(', '),
        Object.entries(signal.debugLast10).map(([key, value]) => `${key}=${value}`).join(', ')
        );
    const baseMin = ticker === "BTC" ? 65 : 60;
    const minConf = signal.volZ > 1.6 ? baseMin + 5 : baseMin;

    if (signal.action === "hold" || signal.confidence < minConf) {
      // no-trade
    } else {
      //check if the opinion is strong for reversal trade
      if (signal.confidence >= 80) {
        const currentPosition = await HyperliquidConnector.getOpenPosition(TRADING_WALLET, ticker)
        if (currentPosition &&
            ((HyperliquidConnector.positionSide(currentPosition) === 'long' && signal.action == 'sell') ||
            (HyperliquidConnector.positionSide(currentPosition) === 'short' && signal.action == 'buy'))) {
          // opposite position exists
          const reversalIndicator = reversalGuard({
            inPosition: HyperliquidConnector.positionSide(currentPosition),
            entryPrice: Number(currentPosition.entryPx),
            lastPrice: Number(lastIndicator.close),
            action: signal.action,
            score: signal.score
          });
          if (reversalIndicator === 'reverse') {
            console.log(`${ticker}: strong confidence reversal signal, reversing position`);
            await HyperliquidConnector.marketClosePosition(TICKERS[ticker],
                HyperliquidConnector.positionSide(currentPosition) === 'long');
          }
        }
      }
      HyperliquidConnector.openOrder(TICKERS[ticker], signal.action == 'buy');
    }
  }
}
