import schedule from "node-schedule";
import {MarketAdaptor} from "./MarketAdaptor";
import {CopyTradingManager} from "./trade/CopyTradingManager";
import {HyperliquidConnector} from "./trade/HyperliquidConnector";

export class Vault3 {

    static async init(): Promise<any> {
        schedule.scheduleJob("1 * * * *", () => {
            MarketAdaptor.scanMarkets('1h', 'BTC', 15000);
            MarketAdaptor.scanMarkets('1h', 'ETH', 40000);
            MarketAdaptor.scanMarkets('1h', 'XRP', 60000);
        });
        schedule.scheduleJob("*/15 * * * *", () => {
            CopyTradingManager.scanTraders();
        });
    }
}
