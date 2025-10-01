import schedule from "node-schedule";
import {runMainStrategy1h, subscribeToEvents} from "./strategies/MainStrategy1h";

export class Vault3 {

    static async init(): Promise<any> {
        subscribeToEvents();
        schedule.scheduleJob("1 * * * *", () => {
            setTimeout(() => {
                runMainStrategy1h(['ETH']);
            }, 10000);
            setTimeout(() => {
                runMainStrategy1h(['BTC']);
            }, 45000);
        });
        /*schedule.scheduleJob("*!/30 * * * *", () => {
            CopyTradingManager.scanTraders();
        });
        CopyTradingManager.watchTraders();*/
    }
}
