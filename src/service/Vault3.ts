import schedule from "node-schedule";
import {MarketAdaptor} from "./MarketAdaptor";
import {CopyTradingManager} from "./trade/CopyTradingManager";

export class Vault3 {

    static async init(): Promise<any> {
        schedule.scheduleJob("1 * * * *", () => {
            MarketAdaptor.scanMarkets('1h');
            CopyTradingManager.scanTraders();
        })
    }
}
