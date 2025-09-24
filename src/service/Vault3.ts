import schedule from "node-schedule";
import {MainStrategy15m} from "./strategies/MainStrategy15m";

export class Vault3 {

    static async init(): Promise<any> {
        MainStrategy15m.subscribeToEvents();
        schedule.scheduleJob("1 * * * *", () => {
            MainStrategy15m.scanMarkets('15m', 'ETH', 10000);
            MainStrategy15m.scanMarkets('15m', 'BTC', 40000);
        });
        /*schedule.scheduleJob("*!/30 * * * *", () => {
            CopyTradingManager.scanTraders();
        });
        CopyTradingManager.watchTraders();*/
    }
}
