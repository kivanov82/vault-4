export const tpSl = {
    BTC: { long: { tp: 20, sl: 10 }, short: { tp: 22, sl: 12 } },
    ETH: { long: { tp: 34, sl: 10 }, short: { tp: 20, sl: 12 } },
} as const;

export const singleOrderSize = 0.3;
export const takeProfitSize = 100;  // %
