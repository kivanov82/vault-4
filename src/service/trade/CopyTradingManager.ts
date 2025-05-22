import dotenv from "dotenv";
import * as hl from "@nktkas/hyperliquid";
import {HyperliquidConnector, TICKERS} from "./HyperliquidConnector";

dotenv.config(); // Load environment variables

const WALLET = process.env.WALLET as `0x${string}`;
const COPY_TRADER = process.env.COPY_TRADER as `0x${string}`;
const COPY_TICKERS = process.env.COPY_TICKERS.split(',');

export class CopyTradingManager {

    static scanTraders() {
        COPY_TICKERS.map(async ticker => {
            try {
                const traderPosition = await HyperliquidConnector.getOpenPosition(COPY_TRADER, ticker);
                const tradingPosition = await HyperliquidConnector.getOpenPosition(WALLET, ticker);
                if (traderPosition && tradingPosition &&
                    HyperliquidConnector.positionSide(traderPosition) === HyperliquidConnector.positionSide(tradingPosition)) {
                    //both exist, on the same side
                    //console.log(`COPY TRADING: both ${ticker} positions exist, on the same side`);
                    HyperliquidConnector.considerTakingProfit(tradingPosition);
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
            } catch (e) {
                console.error(`COPY TRADING: error while scanning ${ticker} positions, retrying...`, e.message);
                //this.scanTraders();
            }
        });

    }

    static watchTraders() {
        const transport = new hl.WebSocketTransport();
        const client = new hl.EventClient({ transport });
        client.userEvents({user: COPY_TRADER},
            async (data) => {
                try {
                    if (data && 'fills' in data) {
                        const fills = data.fills;
                        const { coin, side } = fills[0];
                        if (TICKERS[coin]) {
                            const tradingPosition = await HyperliquidConnector.getOpenPosition(WALLET, coin);
                            if (tradingPosition &&
                                ((side === 'B' && HyperliquidConnector.positionSide(tradingPosition) === 'long') ||
                                side === 'A' && HyperliquidConnector.positionSide(tradingPosition) === 'short')) {
                                //console.log(`COPY TRADING REACTION: both ${coin} positions exist, on the same side`);
                            } else if (tradingPosition &&
                                ((side === 'A' && HyperliquidConnector.positionSide(tradingPosition) === 'long') ||
                                    side === 'B' && HyperliquidConnector.positionSide(tradingPosition) === 'short')) {
                                console.log(`COPY TRADING REACTION: both ${coin} positions exist, BUT on opposite sides`);
                                //close
                                await HyperliquidConnector.marketCloseOrder(coin,
                                    HyperliquidConnector.positionSide(tradingPosition) === 'long');
                                //open new
                                await HyperliquidConnector.openOrder(coin, side === 'B');
                            } else if (!tradingPosition) {
                                //open OUR position
                                console.log(`COPY TRADING REACTION: open ${coin} position`);
                                await HyperliquidConnector.openOrder(coin, side === 'B');
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error in userEvents subscription:', error);
                }
            });

    }
}

