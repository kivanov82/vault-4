import schedule from "node-schedule";
import {oneHTrendChange} from "./strategies/1hTrendChange";
import {CopyTradingManager} from "./trade/CopyTradingManager";
import {HyperliquidConnector} from "./trade/HyperliquidConnector";
import {fifteenMinAOChange} from "./strategies/15mAOChange";
import {openAI} from "./strategies/15mOpenAI";

export class Vault3 {

    static async init(): Promise<any> {
        //schedule.scheduleJob("1 * * * *", () => {
        //schedule.scheduleJob("*/15 * * * *", () => {
        openAI.subscribeToEvents();
        schedule.scheduleJob("1 * * * *", () => {
            //MarketAdaptor.scanMarkets('1h', 'BTC', 15000);
            //oneHTrendChange.scanMarkets('1h', 'ETH', 40000);
            //fifteenMinAOChange.scanMarkets('15m', 'ETH', 10000);
            //MarketAdaptor.scanMarkets('1h', 'XRP', 60000);
            openAI.scanMarkets('15m', 'ETH', 10000);
            openAI.scanMarkets('15m', 'BTC', 40000);
        });
        /*schedule.scheduleJob("*!/30 * * * *", () => {
            CopyTradingManager.scanTraders();
        });
        CopyTradingManager.watchTraders();*/
    }
}
