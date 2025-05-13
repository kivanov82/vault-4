import * as hl from "@nktkas/hyperliquid";
import {privateKeyToAccount} from "viem/accounts";
import dotenv from "dotenv";

dotenv.config(); // Load environment variables

const wallet = process.env.WALLET as `0x${string}`;
const pKey = process.env.WALLET_PK as `0x${string}`;

const SL_PERCENT = 50;  // %
const ORDER_SIZE = 0.3;

export const TICKER = {
    BTC: {
        syn: 'BTC',
        id: 0,
        leverage: 40,
    }
}

export class TradingManager {

    static test(){
    }

    static makePositionRiskNeutral(ticker, long: boolean) {
        this.getOpenPosition(ticker.syn).then(position => {
            if (position) {
                this.getMarket(ticker.syn).then(market => {
                    const orderInstantPrice = long ? (market * 99 / 100) : (market * 101 / 100);
                    this.getClients().wallet.order({
                        orders: [
                            {
                                a: ticker.id,
                                b: !long,
                                p: orderInstantPrice.toFixed(0).toString(),
                                s: '0',
                                r: true,   // reduce-only
                                t: {
                                    trigger: {
                                        isMarket: true,
                                        triggerPx: position.entryPx,
                                        tpsl: "sl"
                                    },
                                },
                            }
                        ],
                        grouping: "positionTpsl",
                    }).then((result) => {
                        console.log(result.response);
                    }).catch(error => {
                        console.error(error)
                    });
                });
            }
        })
    }

    static marketCloseOrder(ticker, long: boolean) {
        this.getOpenPosition(ticker).then(position => {
            if (position) {
                this.getMarket(ticker.syn).then(market => {
                    //for instant fill
                    const orderInstantPrice = long ? (market * 99 / 100) : (market * 101 / 100);
                    this.getClients().wallet.order({
                        orders: [
                            {
                                a: ticker.id,
                                b: !long,
                                p: orderInstantPrice.toFixed(0).toString(),
                                s: position.szi,
                                r: true,   // reduce-only
                                t: {
                                    limit: {
                                        tif: 'FrontendMarket'
                                    }
                                }
                            }
                        ],
                        grouping: "na",
                    }).then((result) => {
                        console.log(result.response);
                    }).catch(error => {
                        console.error(error)
                    });
                });
            }
        });
    }

    static openOrder(ticker, long: boolean) {
        return this.getOpenPosition(ticker).then((position) => {
            if (position && this.positionSide(position) === 'long' && long) {
                console.log('LONG Position already exists');
                return;
            } else if (position && this.positionSide(position) === 'short' && !long) {
                console.log('SHORT Position already exists');
                return;
            }
            return this.getPortfolio().then(balance => {
                return this.getMarket(ticker.syn).then(market => {
                    //for instant fill
                    const orderInstantPrice = long ? (market * 101 / 100) : (market * 99 / 100);
                    const slPrice = long ? (market * (100 - (SL_PERCENT / ticker.leverage)) / 100) : (market * (100 + (SL_PERCENT / ticker.leverage)) / 100);
                    const slInstantPrice = long ? (slPrice * 100.01 / 100) : (slPrice * 99.99 / 100);
                    const sizeInAsset = balance * ORDER_SIZE;
                    const orderSize = ((sizeInAsset * ticker.leverage)/ market).toFixed(5);
                    this.getClients().wallet.order({
                        orders: [
                            //Main order
                            {
                                a: ticker.id,
                                b: long,
                                p: orderInstantPrice.toFixed(0).toString(),
                                s: orderSize.toString(),
                                r: false,   // Not reduce-only
                                t: {
                                    limit: {
                                        tif: 'FrontendMarket'
                                    }
                                }
                            },
                            //SL
                            {
                                a: ticker.id,
                                b: !long,
                                p: slInstantPrice.toFixed(0).toString(),
                                s: orderSize.toString(),
                                r: true,   // reduce-only
                                t: {
                                    trigger: {
                                        isMarket: true,
                                        triggerPx: slPrice.toFixed(0).toString(),
                                        tpsl: "sl"
                                    },
                                },
                            }
                        ],
                        grouping: "normalTpsl",
                    }).then((result) => {
                        console.log(result.response);
                    }).catch(error => {
                        console.error(error)
                    });
                });
            })
        });
    }

    static getOpenPosition(ticker) {
        return this.getClients().public.clearinghouseState({user: wallet}).then(details => {
            return details.assetPositions.find(position => position.position.coin === ticker.syn)?.position;
        })
    }

    static getMarket(ticker) {
        return this.getClients().public.allMids().then(market => {
            return Number(market[ticker]);
        });
    }

    static getOrders() {
        return this.getClients().public.userFills({user: wallet, aggregateByTime: true}).then(orders => {
            console.log(orders);
            return orders;
        })
    }

    static getPortfolio() {
        return this.getClients().public.portfolio({user: wallet}).then(portfolio => {
            //forth element in the 'daily' overview
            const currentBalanceUSDC = portfolio[0][1].accountValueHistory[3][1];
            return Number(currentBalanceUSDC);
        })
    }

    static positionSide(position) {
        return Number(position.entryPx) > Number(position.liquidationPx) ? 'long' : 'short';
    }

    static getClients() {
        const transport = new hl.HttpTransport({
            timeout: 30_000,
            server: "api-ui"
        });
        const viemAccount = privateKeyToAccount(pKey);
        const viemClient = new hl.WalletClient({wallet: viemAccount, transport});
        const client = new hl.PublicClient({transport});
        return {
            public: client,
            wallet: viemClient
        };
    }


}
