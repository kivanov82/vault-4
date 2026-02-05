import axios from "axios";

export type MarketOverlay = {
    btc_7d_change: number | null;
    btc_24h_change: number | null;
    eth_7d_change: number | null;
    eth_24h_change: number | null;
    trend: "up" | "down" | "mixed" | "flat" | "unknown";
    velocity: number | null;
    fearGreed: number | null;
    dominance: number | null;
    funding_btc: number | null;
    funding_eth: number | null;
    dvol: number | null;
    // Enhanced indicators
    total_market_cap_change_24h: number | null;
    btc_oi_change_24h: number | null;
    eth_oi_change_24h: number | null;
    btc_volume_24h: number | null;
    eth_volume_24h: number | null;
    long_short_ratio: number | null;
    sources: {
        coingecko?: string;
        fearGreed?: string;
        hyperliquid?: string;
    };
};

const COINGECKO_BASE =
    process.env.COINGECKO_BASE_URL ?? "https://api.coingecko.com/api/v3";
const FEAR_GREED_URL =
    process.env.FEAR_GREED_URL ?? "https://api.alternative.me/fng/?limit=1";
const HYPERLIQUID_INFO_URL =
    process.env.HYPERLIQUID_INFO_URL ?? "https://api.hyperliquid.xyz/info";
const CACHE_TTL_MS = Number(process.env.MARKET_DATA_TTL_MS ?? 60_000);

let cached: { fetchedAt: number; data: MarketOverlay } | null = null;

export class MarketDataService {
    static async getMarketOverlay(refresh = false): Promise<MarketOverlay> {
        const now = Date.now();
        if (
            !refresh &&
            cached &&
            now - cached.fetchedAt < CACHE_TTL_MS
        ) {
            return cached.data;
        }

        const [
            btcData,
            ethData,
            fearGreed,
            globalData,
            hyperliquidData,
        ] = await Promise.all([
            fetchCoinGeckoAsset("bitcoin"),
            fetchCoinGeckoAsset("ethereum"),
            fetchFearGreed(),
            fetchGlobalMarketData(),
            fetchHyperliquidData(),
        ]);

        const btc7 = btcData?.change_7d ?? null;
        const btc24 = btcData?.change_24h ?? null;
        const eth7 = ethData?.change_7d ?? null;
        const eth24 = ethData?.change_24h ?? null;
        const trend = inferTrend(btc7, btc24);

        const data: MarketOverlay = {
            btc_7d_change: btc7,
            btc_24h_change: btc24,
            eth_7d_change: eth7,
            eth_24h_change: eth24,
            trend,
            velocity: btc24,
            fearGreed: fearGreed?.value ?? null,
            dominance: globalData?.dominance ?? null,
            funding_btc: hyperliquidData?.funding_btc ?? null,
            funding_eth: hyperliquidData?.funding_eth ?? null,
            dvol: null,
            // Enhanced indicators
            total_market_cap_change_24h: globalData?.market_cap_change_24h ?? null,
            btc_oi_change_24h: hyperliquidData?.btc_oi ?? null,
            eth_oi_change_24h: hyperliquidData?.eth_oi ?? null,
            btc_volume_24h: btcData?.volume_24h ?? null,
            eth_volume_24h: ethData?.volume_24h ?? null,
            long_short_ratio: hyperliquidData?.long_short_ratio ?? null,
            sources: {
                coingecko: COINGECKO_BASE,
                fearGreed: FEAR_GREED_URL,
                hyperliquid: HYPERLIQUID_INFO_URL,
            },
        };

        cached = { fetchedAt: now, data };
        return data;
    }
}

type AssetData = {
    change_7d: number | null;
    change_24h: number | null;
    volume_24h: number | null;
};

async function fetchCoinGeckoAsset(coinId: string): Promise<AssetData | null> {
    try {
        const response = await axios.get(
            `${COINGECKO_BASE}/coins/${coinId}`,
            {
                params: {
                    localization: "false",
                    tickers: "false",
                    market_data: "true",
                    community_data: "false",
                    developer_data: "false",
                    sparkline: "false",
                },
            }
        );
        const market = response?.data?.market_data;
        return {
            change_7d: toNumber(market?.price_change_percentage_7d),
            change_24h: toNumber(market?.price_change_percentage_24h),
            volume_24h: toNumber(market?.total_volume?.usd),
        };
    } catch {
        return null;
    }
}

type GlobalMarketData = {
    dominance: number | null;
    market_cap_change_24h: number | null;
};

async function fetchGlobalMarketData(): Promise<GlobalMarketData | null> {
    try {
        const response = await axios.get(`${COINGECKO_BASE}/global`);
        const data = response?.data?.data;
        return {
            dominance: toNumber(data?.market_cap_percentage?.btc),
            market_cap_change_24h: toNumber(data?.market_cap_change_percentage_24h_usd),
        };
    } catch {
        return null;
    }
}

async function fetchFearGreed(): Promise<{ value: number | null } | null> {
    try {
        const response = await axios.get(FEAR_GREED_URL);
        const entry = response?.data?.data?.[0];
        return { value: toNumber(entry?.value) };
    } catch {
        return null;
    }
}

type HyperliquidData = {
    funding_btc: number | null;
    funding_eth: number | null;
    btc_oi: number | null;
    eth_oi: number | null;
    long_short_ratio: number | null;
};

async function fetchHyperliquidData(): Promise<HyperliquidData | null> {
    try {
        const response = await axios.post(HYPERLIQUID_INFO_URL, {
            type: "metaAndAssetCtxs",
        });
        const assetCtxs = Array.isArray(response?.data?.[1])
            ? response.data[1]
            : [];

        const btc = assetCtxs.find(
            (ctx: any) =>
                String(ctx?.name ?? ctx?.coin ?? "").toUpperCase() === "BTC"
        );
        const eth = assetCtxs.find(
            (ctx: any) =>
                String(ctx?.name ?? ctx?.coin ?? "").toUpperCase() === "ETH"
        );

        // Calculate aggregate long/short ratio from open interest data
        let totalLongOi = 0;
        let totalShortOi = 0;
        for (const ctx of assetCtxs) {
            const oi = toNumber(ctx?.openInterest);
            if (oi && oi > 0) {
                // Hyperliquid doesn't split long/short directly, use funding as proxy
                const funding = toNumber(ctx?.funding);
                if (funding !== null) {
                    if (funding > 0) {
                        totalLongOi += oi;
                    } else {
                        totalShortOi += oi;
                    }
                }
            }
        }
        const longShortRatio = totalShortOi > 0
            ? totalLongOi / totalShortOi
            : null;

        return {
            funding_btc: toNumber(btc?.funding),
            funding_eth: toNumber(eth?.funding),
            btc_oi: toNumber(btc?.openInterest),
            eth_oi: toNumber(eth?.openInterest),
            long_short_ratio: longShortRatio,
        };
    } catch {
        return null;
    }
}

function inferTrend(
    btc7: number | null,
    btc24: number | null
): "up" | "down" | "mixed" | "flat" | "unknown" {
    if (!Number.isFinite(btc7) || !Number.isFinite(btc24)) return "unknown";
    if (Math.abs(btc7) < 0.25 && Math.abs(btc24) < 0.25) return "flat";
    if (btc7 > 0 && btc24 > 0) return "up";
    if (btc7 < 0 && btc24 < 0) return "down";
    return "mixed";
}

function toNumber(value: any): number | null {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}
