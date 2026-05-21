import axios from "axios";
import { logger } from "../utils/logger";

const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const USER_AGENT = "vault-4-news-bot/1.0";

const HOT_KEYWORDS =
    /hyperliquid|lighter|perps?|derivative|futures|funding|liquidation|leverage|cex|dex|drift|aevo|gmx|vertex|cme/i;

const RSS_SOURCES: { name: string; url: string }[] = [
    { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
    { name: "Decrypt", url: "https://decrypt.co/feed" },
    { name: "The Defiant", url: "https://thedefiant.io/feed" },
    { name: "DLNews", url: "https://www.dlnews.com/arc/outboundfeeds/rss/?outputType=xml" },
];

const REDDIT_SUBS = ["Hyperliquid", "CryptoCurrency", "ethfinance"];

export type NewsItem = {
    title: string;
    url: string;
    source: string;
    publishedAt: string;
    topics: string[];
};

let cached: { fetchedAt: number; items: NewsItem[] } | null = null;

/**
 * Fetches recent hot topics about Hyperliquid, Lighter, perps trading.
 * Sources are FREE and require no auth:
 *  - RSS feeds from major crypto news sites (Cointelegraph, Decrypt, etc.)
 *  - Reddit JSON for community pulse (r/Hyperliquid, r/CryptoCurrency)
 *
 * Items are filtered by keyword relevance to perps / Hyperliquid / Lighter,
 * deduped, and sorted by recency. Used as `{HOT_TOPICS}` context in the
 * `news_react` X post content type.
 */
export class NewsService {
    static async getHotTopics(refresh = false): Promise<NewsItem[]> {
        const now = Date.now();
        if (!refresh && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
            return cached.items;
        }
        try {
            const rssResults = await Promise.all(
                RSS_SOURCES.map((s) => this.fetchRss(s.url, s.name))
            );
            const redditResults = await Promise.all(
                REDDIT_SUBS.map((s) => this.fetchReddit(s))
            );
            const all = [...rssResults.flat(), ...redditResults.flat()];
            const dedup = new Map<string, NewsItem>();
            for (const item of all) {
                if (item.url && !dedup.has(item.url)) dedup.set(item.url, item);
            }
            const filtered = [...dedup.values()]
                .filter((item) => HOT_KEYWORDS.test(item.title))
                .sort(
                    (a, b) =>
                        Date.parse(b.publishedAt || "0") -
                        Date.parse(a.publishedAt || "0")
                )
                .slice(0, 8);
            cached = { fetchedAt: now, items: filtered };
            logger.info("News fetched", {
                count: filtered.length,
                totalChecked: dedup.size,
            });
            return filtered;
        } catch (error: any) {
            logger.warn("News fetch failed", { message: error?.message });
            return cached?.items ?? [];
        }
    }

    private static async fetchRss(
        url: string,
        sourceName: string
    ): Promise<NewsItem[]> {
        try {
            const response = await axios.get<string>(url, {
                timeout: FETCH_TIMEOUT_MS,
                headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml,application/xml,text/xml" },
                responseType: "text",
                transformResponse: [(data) => data],
            });
            return parseRssItems(response.data, sourceName);
        } catch (error: any) {
            logger.warn("RSS fetch failed", {
                source: sourceName,
                message: error?.message,
            });
            return [];
        }
    }

    private static async fetchReddit(sub: string): Promise<NewsItem[]> {
        try {
            const response = await axios.get(
                `https://www.reddit.com/r/${sub}/hot.json?limit=15`,
                {
                    timeout: FETCH_TIMEOUT_MS,
                    headers: { "User-Agent": USER_AGENT },
                }
            );
            const children = response.data?.data?.children;
            if (!Array.isArray(children)) return [];
            return children
                .map((c: any) => c?.data)
                .filter((d: any) => d && typeof d.title === "string")
                .map((d: any) => ({
                    title: String(d.title).trim(),
                    url: d.url_overridden_by_dest
                        ? String(d.url_overridden_by_dest)
                        : `https://reddit.com${d.permalink}`,
                    source: `r/${sub}`,
                    publishedAt: d.created_utc
                        ? new Date(d.created_utc * 1000).toISOString()
                        : "",
                    topics: [],
                }));
        } catch (error: any) {
            logger.warn("Reddit fetch failed", {
                sub,
                message: error?.message,
            });
            return [];
        }
    }
}

function parseRssItems(xml: string, sourceName: string): NewsItem[] {
    const items: NewsItem[] = [];
    const itemRegex = /<item[\s>][\s\S]*?<\/item>/gi;
    const matches = xml.match(itemRegex);
    if (!matches) return items;
    for (const block of matches) {
        const title = extractTag(block, "title");
        const link = extractTag(block, "link");
        const pubDate = extractTag(block, "pubDate") || extractTag(block, "dc:date");
        if (!title || !link) continue;
        items.push({
            title: decodeHtml(title).trim(),
            url: link.trim(),
            source: sourceName,
            publishedAt: pubDate ? new Date(pubDate).toISOString() : "",
            topics: [],
        });
    }
    return items;
}

function extractTag(xml: string, tag: string): string | null {
    const re = new RegExp(
        `<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`,
        "i"
    );
    const m = xml.match(re);
    return m ? m[1] : null;
}

function decodeHtml(s: string): string {
    return s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}
