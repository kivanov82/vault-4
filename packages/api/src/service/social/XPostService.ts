import { TwitterApi } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../utils/logger";
import { MarketDataService, MarketOverlay } from "../claude/MarketDataService";
import { VaultService } from "../vaults/VaultService";
import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import { NewsService, NewsItem } from "./NewsService";

const X_API_KEY = process.env.X_API_KEY;
const X_API_SECRET = process.env.X_API_SECRET;
const X_ACCESS_TOKEN = process.env.X_ACCESS_TOKEN;
const X_ACCESS_SECRET = process.env.X_ACCESS_SECRET;

interface SettlementContext {
    epoch: number;
    totalAssets: number;
    sharePrice: number;
    prevSharePrice: number;
    deployedToL1: number;
    depositsProcessed: number;
    withdrawsProcessed: number;
    allocations: Array<{
        vault: string;
        allocationUsd: number | null;
        roePct: number | null;
    }>;
}

interface DailyPostContext {
    pnlChangeWeeklyPct: number | null;
    pnlChange30dPct: number | null;
    pnlChangeInceptionPct: number | null;
    daysSinceInception: number;
    winRatePct: number | null;
    maxDrawdownPct: number | null;
    topWinnerRoePct: number | null;
    topWinnerTicker: string | null;
    topWinnerDirection: "long" | "short" | "neutral" | null;
}

/**
 * Weighted content mix.
 * Each entry can appear multiple times to bias rotation.
 * Performance/engine topics are GATED in pickContentType — they only enter
 * the pool when the underlying data supports them (positive %, etc.).
 */
const CONTENT_MIX = [
    // Educational — sharp points about market mechanics
    "concept_perp_funding",
    "concept_perp_funding",
    "concept_open_interest",
    "concept_basis_carry",
    "concept_long_short_skew",
    "concept_liquidations",
    // Market commentary — react to today's data
    "market_funding_signal",
    "market_funding_signal",
    "market_oi_buildup",
    "market_sentiment_extreme",
    "market_hyperliquid_flow",
    // Performance — POSITIVE only, gated downstream
    "perf_weekly_positive",
    "perf_monthly_positive",
    "perf_inception_positive",
    "perf_top_token",
    "perf_top_token",
    // Engine — how the AI picks / rotates / risks
    "engine_ranking",
    "engine_rebalance",
    "engine_risk",
    "engine_market_overlay",
    // News reaction — gated to only fire when hot topics are available
    "news_react",
    "news_react",
] as const;

const TWEET_PROMPT = `You are a perps trader on Twitter. You run an AI strategy that picks and rotates positions on Hyperliquid. You post short, useful observations — the kind a fellow trader stops scrolling for.

NEVER use the word "vault" or "vaults". The reader doesn't know what a vault is. Speak about your strategy, positions, the AI, the algo, your portfolio — never "vault". When describing what the AI picks, say "strategies", "traders", "positions", or "allocations" — never "vaults".

Today's data you can draw from:

Performance & engine:
{PORTFOLIO_CONTEXT}

Live market:
{MARKET_DATA}

Recent hot topics in crypto perps / Hyperliquid / Lighter:
{HOT_TOPICS}

Topic for this post: {CONTENT_TYPE}

═══ TOPIC GUIDE ═══

concept_perp_funding: Explain something about funding rates. How they work, what extreme readings mean, what flipping signs implies. Use a number from {MARKET_DATA} as a hook if relevant.

concept_open_interest: What OI is, how to read OI changes alongside price, when buildup is bullish vs distribution.

concept_basis_carry: Spot-vs-perp basis, cash-and-carry, why funding compresses in bull markets.

concept_long_short_skew: When the long/short ratio gets extreme, what historically follows. No fortune-telling.

concept_liquidations: How forced liquidations cascade, why thin books amplify, when "liquidation wicks" mark local extremes.

market_funding_signal: React to current funding numbers in {MARKET_DATA}. Specific numbers required.

market_oi_buildup: React to OI changes. What's happening in positioning.

market_sentiment_extreme: Use fearGreed, long_short_ratio. Call out where sentiment sits and what usually precedes — without fortune-telling.

market_hyperliquid_flow: Comment on Hyperliquid-specific dynamics — L1 flows, perps liquidity. Tag @HyperliquidX only if natural.

perf_weekly_positive: ONLY use when {PORTFOLIO_CONTEXT} has positive pnlChangeWeeklyPct. State the weekly % gain plainly with one sentence of context. Tie to a regime observation if possible.

perf_monthly_positive: ONLY use when monthly % is positive. State the number and add a one-line "why" — pull from regime/funding/OI in {MARKET_DATA} if you can.

perf_inception_positive: ONLY use when inception % is positive. State the % return and the duration in days. Add one observation about the regime that drove it.

perf_top_token: Name the asset currently driving gains (from topWinnerTicker in context). State the position direction (long/short) and a single hashtag like #BTC or #SOL. One sentence on why this trade is working given current market context. No prediction language.

engine_ranking: Explain how the AI ranks candidate strategies — score-based, market-aware, two-stage filtering. ~200+ candidates scored, top dozen ranked. Be specific. No "vault" word.

engine_rebalance: How rebalancing decisions work — 80/20 barbell allocation, trim over-allocated positions back to target, exit when not in the new picks. Concrete numbers if you have them.

engine_risk: Risk management — hard stop at -25% ROE, soft stop at -15% with alignment check, 5-day minimum hold to avoid noise-trading, max 60% concentration in one direction. Pick ONE of these to explain.

engine_market_overlay: How the strategy ingests market context — BTC/ETH funding, OI changes, sentiment indicators — and tilts the allocation toward the regime. Concrete: which signals dominated this cycle.

news_react: Pick the SINGLE most interesting item from {HOT_TOPICS} (Hyperliquid, Lighter, perps ecosystem news). Write a one-paragraph trader's-take on it — your angle, not a news summary. If the item mentions a coin, you may use ONE hashtag. If nothing in {HOT_TOPICS} is genuinely interesting, do not force this topic; pivot to a market_* observation.

═══ EXAMPLES OF THE VOICE WE WANT ═══

Good — perf_weekly_positive:
"+8.2% on the AI portfolio this week. Long bias paid off — funding stayed positive on majors and the trend held through Friday. Most of the gain came from sticking with the trades that worked instead of rotating into chop."

Good — perf_top_token:
"The strategy's been net long #BTC through the past week. Funding flipped briefly to negative Tuesday, didn't faze the trade — funding flips aren't trend reversals unless OI confirms. Up ~+6% on the position so far."

Good — engine_risk:
"Hard stop at -25% on any single position. Soft stop at -15%, but only if the position isn't aligned with the regime — otherwise we hold. The point isn't to never lose; it's to not be the trader who rides one loser down to zero."

Good — concept_perp_funding:
"Funding on HYPE flipped negative for the first time in 6 days. Shorts now paying longs. On a coin that just ran +20%, that's usually late shorts capitulating or smart money hedging the next leg up."

Bad — DO NOT WRITE LIKE THIS:
"Excited to share VAULT-4's performance!" (uses 'vault', uses 'excited')
"Our AI vault crushed it this week 🚀" (uses 'vault', uses emoji, uses 'crushed')
"Just rebalanced — barbell strategy delivering serious alpha" (uses 'just', uses 'alpha')

═══ HARD RULES ═══

- 180-270 characters total. One post, no threads.
- Plain text. NO emojis. NO em-dashes used as decoration.
- Hashtags ONLY on perf_top_token, and ONLY one ticker hashtag (e.g. #BTC, #ETH, #SOL).
- Never use the word "vault" or "vaults".
- NEVER use: "Just", "Did you know", "Here's why", "Excited", "Thrilled", "Crushing", "Alpha", "Game-changer", "Revolutionize", "Cutting-edge", "Dive in", "Wagmi", "leverage" as a verb.
- Never use rocket, fire, money-bag, or any emoji.
- Never make predictions or forecasts. Observations only.
- For perf_* posts: state facts. No celebration. No adjectives like "great"/"amazing"/"incredible".
- Tag @HyperliquidX only when actually discussing Hyperliquid-specific dynamics.
- Numbers must come from {PORTFOLIO_CONTEXT} or {MARKET_DATA} — never invent.
- If you have nothing specific to say on the topic, write a tighter post about something adjacent — never pad.

Pick the form that fits the content. A single line is often enough.`;

export class XPostService {
    private static xClient: TwitterApi | null = null;
    private static aiClient: Anthropic | null = null;
    private static postIndex = 0;
    private static lastContentType: string | null = null;

    private static getXClient(): TwitterApi | null {
        if (this.xClient) return this.xClient;
        if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
            return null;
        }
        this.xClient = new TwitterApi({
            appKey: X_API_KEY,
            appSecret: X_API_SECRET,
            accessToken: X_ACCESS_TOKEN,
            accessSecret: X_ACCESS_SECRET,
        });
        return this.xClient;
    }

    private static getAIClient(): Anthropic | null {
        if (this.aiClient) return this.aiClient;
        if (!process.env.ANTHROPIC_API_KEY) return null;
        this.aiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        return this.aiClient;
    }

    static isConfigured(): boolean {
        return !!(X_API_KEY && X_API_SECRET && X_ACCESS_TOKEN && X_ACCESS_SECRET);
    }

    /**
     * Daily-scheduled tweet (called by XPostScheduler with jittered cadence).
     * Builds rich performance context, picks a content type that the current
     * data actually supports (positive perf gated), and publishes.
     */
    static async runDailyPost(): Promise<void> {
        const xClient = this.getXClient();
        if (!xClient) {
            logger.info("X daily post skipped: API keys not configured");
            return;
        }
        const context = await this.buildDailyContext();
        const tweet = await this.generateDailyTweet(context);
        if (!tweet) {
            logger.warn("X daily post skipped: failed to generate tweet");
            return;
        }
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const result = await xClient.v2.tweet(tweet);
                logger.info("X post published", {
                    tweetId: result.data.id,
                    content: tweet,
                });
                return;
            } catch (error: any) {
                logger.warn("X post failed", {
                    message: error?.message,
                    attempt,
                });
                if (attempt === 1 && error?.code === 403) {
                    await new Promise((r) => setTimeout(r, 60_000));
                }
            }
        }
    }

    /**
     * Settlement-driven post — fired by VaultContractService.runSettlement().
     * Kept for back-compat; on most days the daily scheduler will already have
     * posted, so this becomes a no-op via the duplicate-content guard.
     */
    static async postSettlementUpdate(_context: SettlementContext): Promise<void> {
        // Settlement-coupled posts are superseded by the daily scheduler.
        // Keep the method for the test endpoint, but route through the same
        // daily path to avoid duplicate/conflicting content rules.
        return this.runDailyPost();
    }

    private static async buildDailyContext(): Promise<DailyPostContext> {
        let pnlChange30dPct: number | null = null;
        let pnlChangeInceptionPct: number | null = null;
        let daysSinceInception = 0;
        let winRatePct: number | null = null;
        let maxDrawdownPct: number | null = null;
        try {
            const metrics = await VaultService.getPlatformPerformanceMetrics({});
            pnlChange30dPct = metrics.pnlChange30dPct;
            pnlChangeInceptionPct = metrics.pnlChangeInceptionPct;
            daysSinceInception = metrics.daysSinceInception;
            winRatePct = metrics.winRatePct;
            maxDrawdownPct = metrics.maxDrawdownPct;
        } catch (error: any) {
            logger.warn("buildDailyContext: metrics fetch failed", {
                message: error?.message,
            });
        }

        // Weekly: approximate from 30d / 60d series isn't directly exposed —
        // for now derive a rough weekly via inception-pct scaled to 7d if no
        // dedicated metric. Conservative: leave null and let topic gate skip.
        const pnlChangeWeeklyPct: number | null = null;

        // Top winner: find the position with the highest positive ROE, then
        // fetch its dominant trading asset to pull a ticker for the hashtag.
        let topWinnerRoePct: number | null = null;
        let topWinnerTicker: string | null = null;
        let topWinnerDirection: "long" | "short" | "neutral" | null = null;
        try {
            const positions = await VaultService.getPlatformPositions({});
            const winners = positions.positions
                .filter((p) => (p.roePct ?? 0) > 0)
                .sort((a, b) => (b.roePct ?? 0) - (a.roePct ?? 0));
            const top = winners[0];
            if (top && top.roePct != null) {
                topWinnerRoePct = top.roePct;
                const summary = await HyperliquidConnector.getVaultAccountSummary(
                    top.vaultAddress
                );
                const dominant = pickDominantAsset(summary.assetPositions);
                topWinnerTicker = dominant?.coin ?? null;
                topWinnerDirection = dominant?.direction ?? null;
            }
        } catch (error: any) {
            logger.warn("buildDailyContext: top winner fetch failed", {
                message: error?.message,
            });
        }

        return {
            pnlChangeWeeklyPct,
            pnlChange30dPct,
            pnlChangeInceptionPct,
            daysSinceInception,
            winRatePct,
            maxDrawdownPct,
            topWinnerRoePct,
            topWinnerTicker,
            topWinnerDirection,
        };
    }

    private static async generateDailyTweet(
        context: DailyPostContext
    ): Promise<string | null> {
        const ai = this.getAIClient();
        if (!ai) return null;

        const [marketData, hotTopics] = await Promise.all([
            MarketDataService.getMarketOverlay().catch((error: any) => {
                logger.warn("Market data fetch failed for tweet", {
                    message: error?.message,
                });
                return null as MarketOverlay | null;
            }),
            NewsService.getHotTopics().catch((error: any) => {
                logger.warn("News fetch failed for tweet", {
                    message: error?.message,
                });
                return [] as NewsItem[];
            }),
        ]);

        const contentType = this.pickContentTypeForContext(context, hotTopics);

        const contextStr = JSON.stringify(context, null, 2);
        const marketDataStr = marketData
            ? JSON.stringify(
                  {
                      btc_24h:
                          marketData.btc_24h_change != null
                              ? `${marketData.btc_24h_change.toFixed(2)}%`
                              : "N/A",
                      btc_7d:
                          marketData.btc_7d_change != null
                              ? `${marketData.btc_7d_change.toFixed(2)}%`
                              : "N/A",
                      eth_24h:
                          marketData.eth_24h_change != null
                              ? `${marketData.eth_24h_change.toFixed(2)}%`
                              : "N/A",
                      trend: marketData.trend,
                      fearGreed: marketData.fearGreed,
                      funding_btc: marketData.funding_btc,
                      funding_eth: marketData.funding_eth,
                      long_short_ratio:
                          marketData.long_short_ratio != null
                              ? marketData.long_short_ratio.toFixed(2)
                              : "N/A",
                      btc_oi: marketData.btc_oi_change_24h,
                      preferred_direction: marketData.preferred_direction,
                  },
                  null,
                  2
              )
            : "Market data unavailable";

        const hotTopicsStr = hotTopics.length
            ? hotTopics
                  .map(
                      (n, i) =>
                          `${i + 1}. ${n.title} — ${n.source} (${
                              n.publishedAt
                          })${n.topics.length ? ` [${n.topics.join(",")}]` : ""}`
                  )
                  .join("\n")
            : "No recent hot topics fetched.";

        const prompt = TWEET_PROMPT.replace("{PORTFOLIO_CONTEXT}", contextStr)
            .replace("{CONTENT_TYPE}", contentType)
            .replace("{MARKET_DATA}", marketDataStr)
            .replace("{HOT_TOPICS}", hotTopicsStr);

        try {
            const response = await ai.messages.create({
                model: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6",
                max_tokens: 250,
                temperature: 0.8,
                messages: [{ role: "user", content: prompt }],
            });
            const text =
                response.content[0].type === "text"
                    ? response.content[0].text.trim()
                    : null;
            if (!text) return null;
            // Guardrails: drop the post if it slipped 'vault' through the prompt.
            if (/\bvault(s)?\b/i.test(text)) {
                logger.warn(
                    "Tweet rejected: contains forbidden 'vault' word",
                    { contentType, text }
                );
                return null;
            }
            if (text.length > 280) {
                logger.warn("Generated tweet too long", {
                    contentType,
                    length: text.length,
                });
                return null;
            }
            this.postIndex++;
            this.lastContentType = contentType;
            logger.info("Tweet generated", {
                contentType,
                length: text.length,
            });
            return text;
        } catch (error: any) {
            logger.warn("Claude tweet generation failed", {
                message: error?.message,
            });
            return null;
        }
    }

    private static pickContentTypeForContext(
        context: DailyPostContext,
        hotTopics: NewsItem[]
    ): string {
        const pool = CONTENT_MIX.filter((t) => {
            if (t === "perf_weekly_positive")
                return (
                    context.pnlChangeWeeklyPct != null &&
                    context.pnlChangeWeeklyPct > 0
                );
            if (t === "perf_monthly_positive")
                return (
                    context.pnlChange30dPct != null &&
                    context.pnlChange30dPct > 0
                );
            if (t === "perf_inception_positive")
                return (
                    context.pnlChangeInceptionPct != null &&
                    context.pnlChangeInceptionPct > 0
                );
            if (t === "perf_top_token")
                return (
                    context.topWinnerTicker != null &&
                    (context.topWinnerRoePct ?? 0) > 5
                );
            if (t === "news_react") return hotTopics.length > 0;
            return true;
        });
        // Avoid back-to-back identical content type.
        const filtered = pool.filter((t) => t !== this.lastContentType);
        const finalPool = filtered.length ? filtered : pool;
        if (!finalPool.length) return "concept_perp_funding";
        const idx = Math.floor(Math.random() * finalPool.length);
        return finalPool[idx];
    }
}

function pickDominantAsset(
    assetPositions: any[]
): { coin: string; direction: "long" | "short" } | null {
    if (!Array.isArray(assetPositions) || !assetPositions.length) return null;
    let best: { coin: string; direction: "long" | "short"; absValue: number } | null = null;
    for (const entry of assetPositions) {
        const pos = entry?.position;
        if (!pos) continue;
        const coin = typeof pos.coin === "string" ? pos.coin : null;
        const szi = Number(pos.szi);
        const value = Number(pos.positionValue ?? 0);
        if (!coin || !Number.isFinite(szi) || !Number.isFinite(value)) continue;
        const absValue = Math.abs(value);
        if (best == null || absValue > best.absValue) {
            best = {
                coin,
                direction: szi >= 0 ? "long" : "short",
                absValue,
            };
        }
    }
    if (!best) return null;
    return { coin: best.coin, direction: best.direction };
}
