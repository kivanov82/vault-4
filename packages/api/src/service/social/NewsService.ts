import axios from "axios";
import { logger } from "../utils/logger";

const CRYPTOPANIC_BASE = "https://cryptopanic.com/api/v1/posts/";
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const HOT_KEYWORDS = /hyperliquid|lighter|perps?|derivative|futures|funding|liquidation|leverage|cme/i;

export type NewsItem = {
    title: string;
    url: string;
    source: string;
    publishedAt: string;
    topics: string[];
};

let cached: { fetchedAt: number; items: NewsItem[] } | null = null;

/**
 * Fetches recent hot crypto news from CryptoPanic — biased toward Hyperliquid,
 * Lighter, and general perps/derivatives. Used as context for the X post
 * "news_react" content type so the bot can write trader insight on real events.
 *
 * Requires CRYPTOPANIC_API_TOKEN. Without it the service returns [] gracefully
 * and the news content type is skipped from the X post mix.
 */
export class NewsService {
    static async getHotTopics(refresh = false): Promise<NewsItem[]> {
        const token = process.env.CRYPTOPANIC_API_TOKEN;
        if (!token) return [];
        const now = Date.now();
        if (!refresh && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
            return cached.items;
        }
        try {
            const queries: Record<string, string>[] = [
                { currencies: "HYPE", filter: "hot" },
                { filter: "hot" },
                { filter: "rising" },
            ];
            const buckets = await Promise.all(
                queries.map((q) => this.fetch(token, q))
            );
            const dedup = new Map<string, NewsItem>();
            for (const items of buckets) {
                for (const item of items) {
                    if (!dedup.has(item.url)) dedup.set(item.url, item);
                }
            }
            const filtered = [...dedup.values()]
                .filter(
                    (item) =>
                        HOT_KEYWORDS.test(item.title) ||
                        item.topics.includes("HYPE")
                )
                .sort(
                    (a, b) =>
                        Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
                )
                .slice(0, 8);
            cached = { fetchedAt: now, items: filtered };
            logger.info("News fetched", { count: filtered.length });
            return filtered;
        } catch (error: any) {
            logger.warn("News fetch failed", { message: error?.message });
            return cached?.items ?? [];
        }
    }

    private static async fetch(
        token: string,
        query: Record<string, string>
    ): Promise<NewsItem[]> {
        try {
            const params = new URLSearchParams({
                auth_token: token,
                public: "true",
                ...query,
            });
            const response = await axios.get(
                `${CRYPTOPANIC_BASE}?${params.toString()}`,
                { timeout: FETCH_TIMEOUT_MS }
            );
            const posts = Array.isArray(response.data?.results)
                ? response.data.results
                : [];
            return posts.map((p: any) => ({
                title: String(p.title ?? "").trim(),
                url: String(p.url ?? ""),
                source: String(p.source?.title ?? p.domain ?? "crypto"),
                publishedAt: String(p.published_at ?? ""),
                topics: Array.isArray(p.currencies)
                    ? p.currencies.map((c: any) => String(c.code ?? ""))
                    : [],
            }));
        } catch (error: any) {
            logger.warn("CryptoPanic query failed", {
                message: error?.message,
                query,
            });
            return [];
        }
    }
}
