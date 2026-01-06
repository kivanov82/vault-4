import axios from "axios";

export type MarketOverlay = {
    btc_7d_change: number | null;
    btc_24h_change: number | null;
    trend: "up" | "down" | "mixed" | "flat" | "unknown";
    velocity: number | null;
    fearGreed: number | null;
    dominance: number | null;
    funding_btc: number | null;
    dvol: number | null;
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

        const [coingecko, fearGreed, dominance, funding] = await Promise.all([
            fetchCoinGeckoBtc(),
            fetchFearGreed(),
            fetchBtcDominance(),
            fetchHyperliquidFunding(),
        ]);

        const btc7 = coingecko?.btc_7d_change ?? null;
        const btc24 = coingecko?.btc_24h_change ?? null;
        const trend = inferTrend(btc7, btc24);

        const data: MarketOverlay = {
            btc_7d_change: btc7,
            btc_24h_change: btc24,
            trend,
            velocity: btc24,
            fearGreed: fearGreed?.value ?? null,
            dominance: dominance ?? null,
            funding_btc: funding ?? null,
            dvol: null,
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

async function fetchCoinGeckoBtc(): Promise<{
    btc_7d_change: number | null;
    btc_24h_change: number | null;
} | null> {
    try {
        const response = await axios.get(
            `${COINGECKO_BASE}/coins/bitcoin`,
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
            btc_7d_change: toNumber(market?.price_change_percentage_7d),
            btc_24h_change: toNumber(market?.price_change_percentage_24h),
        };
    } catch {
        return null;
    }
}

async function fetchBtcDominance(): Promise<number | null> {
    try {
        const response = await axios.get(`${COINGECKO_BASE}/global`);
        const dominance = response?.data?.data?.market_cap_percentage?.btc;
        return toNumber(dominance);
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

async function fetchHyperliquidFunding(): Promise<number | null> {
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
        return toNumber(btc?.funding);
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
