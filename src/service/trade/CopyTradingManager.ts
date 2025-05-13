import dotenv from "dotenv";
import {HyperliquidConnector, TICKERS} from "./HyperliquidConnector";

dotenv.config(); // Load environment variables

const WALLET = process.env.WALLET as `0x${string}`;
const COPY_TRADER = process.env.COPY_TRADER as `0x${string}`;
const COPY_TICKERS = process.env.COPY_TICKERS.split(',');

export class CopyTradingManager {

    static scanTraders() {
        COPY_TICKERS.map(async ticker => {
            const traderPosition = await HyperliquidConnector.getOpenPosition(COPY_TRADER, ticker);
            const tradingPosition = await HyperliquidConnector.getOpenPosition(WALLET, ticker);
            if (traderPosition && tradingPosition &&
                HyperliquidConnector.positionSide(traderPosition) === HyperliquidConnector.positionSide(tradingPosition)) {
                //both exist, on the same side
                console.log(`COPY TRADING: both ${ticker} positions exist, on the same side`);
            } else if (traderPosition && tradingPosition &&
                HyperliquidConnector.positionSide(traderPosition) !== HyperliquidConnector.positionSide(tradingPosition)) {
                //both exist, BUT on the wrong side
                console.log(`COPY TRADING: both ${ticker} positions exist, BUT on the wrong side`);
                //close
                await HyperliquidConnector.marketCloseOrder(TICKERS[ticker],
                    HyperliquidConnector.positionSide(tradingPosition) === 'long');
                //open new
                await HyperliquidConnector.openOrder(TICKERS[ticker],
                    HyperliquidConnector.positionSide(traderPosition) === 'long');

            } else if (traderPosition && !tradingPosition) {
                //open OUR position
                console.log(`COPY TRADING: open ${ticker} position`);
                await HyperliquidConnector.openOrder(TICKERS[ticker],
                    HyperliquidConnector.positionSide(traderPosition) === 'long');
            } else if (!traderPosition && tradingPosition) {
                //close OUR position
                console.log(`COPY TRADING: close ${ticker} position`);
                await HyperliquidConnector.marketCloseOrder(TICKERS[ticker],
                    HyperliquidConnector.positionSide(tradingPosition) === 'long');
            }
        });

    }
}
