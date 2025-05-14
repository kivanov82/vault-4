import * as hl from "@nktkas/hyperliquid";
import {privateKeyToAccount} from "viem/accounts";
import dotenv from "dotenv";

dotenv.config(); // Load environment variables

const TRADING_WALLET = process.env.WALLET as `0x${string}`;
const TRADING_PKEY = process.env.WALLET_PK as `0x${string}`;

const SL_PERCENT = 50;  // %
const ORDER_SIZE = 0.3;

export const TICKERS = {
    BTC: {
        syn: 'BTC',
        id: 0,
        leverage: 40,
    },
    ETH: {
        syn: 'ETH',
        id: 1,
        leverage: 25,
    },
    kPEPE: {
        syn: 'kPEPE',
        id: 15,
        leverage: 10,
    },
    XRP: {
        syn: 'XRP',
        id: 25,
        leverage: 20,
    },
    FARTCOIN: {
        syn: 'FARTCOIN',
        id: 165,
        leverage: 5,
    },
    TRUMP: {
        syn: 'TRUMP',
        id: 174,
        leverage: 10,
    }
}

export class HyperliquidConnector {

    static makePositionRiskNeutral(ticker, long: boolean) {
        this.getOpenPosition(TRADING_WALLET, ticker.syn).then(position => {
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

    static marketCloseOrder(ticker, long: boolean, percent: number = 1) {
        return this.getOpenPosition(TRADING_WALLET, ticker.syn).then(position => {
            if (position) {
                return this.getMarket(ticker.syn).then(market => {
                    //for instant fill
                    const orderInstantPrice = long ? (market * 99 / 100) : (market * 101 / 100);
                    const orderSize = Number(position.szi) * percent;
                    const orderSizeString = orderSize < 1 ?
                        orderSize.toFixed(5).toString() :
                        orderSize.toFixed(0).toString();
                    return this.getClients().wallet.order({
                        orders: [
                            {
                                a: ticker.id,
                                b: !long,
                                p: orderInstantPrice.toFixed(0).toString(),
                                s: orderSizeString,
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
        return this.getOpenPosition(TRADING_WALLET, ticker.syn).then((position) => {
            if (position && this.positionSide(position) === 'long' && long) {
                console.log('LONG Position already exists');
                return;
            } else if (position && this.positionSide(position) === 'short' && !long) {
                console.log('SHORT Position already exists');
                return;
            }
            return this.getPortfolio(TRADING_WALLET).then(portfolio => {
                return this.getMarket(ticker.syn).then(market => {
                    //for instant fill
                    const orderInstantPrice = long ? (market * 101 / 100) : (market * 99 / 100);
                    const slPrice = long ? (market * (100 - (SL_PERCENT / ticker.leverage)) / 100) : (market * (100 + (SL_PERCENT / ticker.leverage)) / 100);
                    const slInstantPrice = long ? (slPrice * 100.01 / 100) : (slPrice * 99.99 / 100);
                    const sizeInAsset = portfolio.available * ORDER_SIZE;
                    const orderSize = (sizeInAsset * ticker.leverage)/ market;

                    const orderInstantPriceString = orderInstantPrice < 1 ?
                        orderInstantPrice.toFixed(5).toString() :
                        orderInstantPrice.toFixed(0).toString();
                    const slPriceString = slPrice < 1 ?
                        slPrice.toFixed(5).toString() :
                        slPrice.toFixed(0).toString();
                    const slInstantPriceString = slInstantPrice < 1 ?
                        slInstantPrice.toFixed(5).toString() :
                        slInstantPrice.toFixed(0).toString();
                    const orderSizeString = orderSize < 1 ?
                        orderSize.toFixed(5).toString() :
                        orderSize.toFixed(0).toString();

                    return this.getClients().wallet.order({
                        orders: [
                            //Main order
                            {
                                a: ticker.id,
                                b: long,
                                p: orderInstantPriceString,
                                s: orderSizeString,
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
                                p: slInstantPriceString,
                                s: orderSizeString,
                                r: true,   // reduce-only
                                t: {
                                    trigger: {
                                        isMarket: true,
                                        triggerPx: slPriceString,
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

    static getOpenPositions(trader: `0x${string}`) {
        return this.getClients().public.clearinghouseState({user: trader});
    }

    static getOpenPosition(trader: `0x${string}`, tickerSyn: string) {
        return this.getClients().public.clearinghouseState({user: trader}).then(details => {
            return details.assetPositions.find(position => position.position.coin === tickerSyn)?.position;
        })
    }

    static getMarket(ticker) {
        return this.getClients().public.allMids().then(market => {
            return Number(market[ticker]);
        });
    }

    static getOrders() {
        return this.getClients().public.userFills({user: TRADING_WALLET, aggregateByTime: true}).then(orders => {
            console.log(orders);
            return orders;
        })
    }

    static getPortfolio(trader: `0x${string}`) {
        return this.getClients().public.portfolio({user: trader}).then(portfolio => {
            const lastInHistory = portfolio[0][1].accountValueHistory.length - 1;
            const currentBalanceUSDC = portfolio[0][1].accountValueHistory[lastInHistory][1];
            return this.getOpenPositions(trader).then((positions) => {
                const balanceInPositions = positions.assetPositions.reduce((acc, position) => {
                    return Number(position.position.positionValue) / position.position.leverage.value + acc;
                }, 0);
                return {
                    portfolio: Number(currentBalanceUSDC),
                    available: Number(currentBalanceUSDC) - balanceInPositions
                } ;
            });
        })
    }

    static positionSide(position) {
        return Number(position.entryPx) > Number(position.liquidationPx) ? 'long' : 'short';
    }

    static getClients() {
        const transport = new hl.HttpTransport({
            timeout: 40_000,
            //server: "api2"
            server: {
                mainnet: {
                    rpc: 'https://rpc.hypurrscan.io',
                }
            }
        });
        const viemAccount = privateKeyToAccount(TRADING_PKEY);
        const viemClient = new hl.WalletClient({wallet: viemAccount, transport});
        const client = new hl.PublicClient({transport});
        return {
            public: client,
            wallet: viemClient
        };
    }


}
