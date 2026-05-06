import { TwitterApi } from "twitter-api-v2";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../utils/logger";
import { MarketDataService, MarketOverlay } from "../claude/MarketDataService";

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

/**
 * Weighted content mix — ~70% educational/market, ~30% project notes.
 * Each entry can appear multiple times to bias rotation toward education.
 */
const CONTENT_MIX = [
    // Concepts — explain a mechanism, no project pitch
    "concept_perp_funding",
    "concept_perp_funding",
    "concept_open_interest",
    "concept_basis_carry",
    "concept_erc4626_nav",
    "concept_erc4626_nav",
    "concept_vault_risk",
    "concept_copy_trading_failure_modes",
    "concept_settlement_design",
    // Market commentary — react to the data, no pitch
    "market_funding_signal",
    "market_funding_signal",
    "market_oi_buildup",
    "market_sentiment_extreme",
    "market_hyperliquid_flow",
    // Project notes — only when there's actual news
    "project_allocation_change",
    "project_settlement_event",
    "project_lessons_learned",
] as const;

const TWEET_PROMPT = `You are an experienced perps trader who occasionally writes short, useful threads on Twitter. You are NOT writing marketing copy. You are writing the kind of post that another trader stops scrolling for.

You happen to also run a small AI-managed vault on Hyperliquid (VAULT-4 — vault4_xyz on X). You may reference it, but you are not promoting it. Most of your posts have nothing to do with the project at all.

Today's data you can draw from:

Portfolio:
{CONTEXT}

Live market:
{MARKET_DATA}

Topic for this post: {CONTENT_TYPE}

═══ TOPIC GUIDE ═══

concept_perp_funding: Explain something about funding rates. How they work, what extreme readings mean, what flipping signs implies. Use a number from {MARKET_DATA} as the hook if relevant.

concept_open_interest: Explain what OI is, how to read OI changes alongside price, when OI buildup is bullish vs distribution. Hook from market data when possible.

concept_basis_carry: Spot vs perp basis, cash-and-carry, why funding can compress in bull markets. No project mention.

concept_erc4626_nav: Teach a sharp point about ERC-4626 — share price = totalAssets / totalSupply, why "who reports NAV" is the real risk vector, NAV manipulation games, dilution mechanics. Concrete examples.

concept_vault_risk: Risks specific to vaults that copy traders or follow leaders — survivorship bias, capacity decay, manager incentives misalignment. Be specific. No fluff.

concept_copy_trading_failure_modes: One specific failure mode of copy-trading vaults: capacity, latency, slippage on entry, manager rugging vs underperforming, lookback bias in selection. Give the failure a name and explain the mechanism.

concept_settlement_design: How daily-settled vaults differ from instant. Queue-based mechanics, why settlement windows protect both sides, the tradeoff with instant liquidity. Treat it as design discussion, not VAULT-4 promo.

market_funding_signal: React to current funding numbers from {MARKET_DATA}. What does today's reading suggest? Be specific with the actual numbers. No project mention.

market_oi_buildup: React to OI changes. What's happening in positioning. No project mention.

market_sentiment_extreme: Use fearGreed, long_short_ratio. Call out where sentiment is and what it usually precedes — without being a fortune teller.

market_hyperliquid_flow: Comment on Hyperliquid-specific dynamics — vault ecosystem, L1 flows, perps liquidity. Tag @HyperliquidX when natural.

project_allocation_change: ONLY if {CONTEXT} shows a real recent change. Mention what the AI moved into or out of and the one-line reason. This is a brief log entry, not a celebration.

project_settlement_event: ONLY if there's a real settlement number worth sharing (e.g. share price moved meaningfully). State it plainly. Show the data, no adjectives.

project_lessons_learned: Something the project did that didn't work, or a recalibration. Underwater positions, stop-losses that fired, an exit that turned out wrong. Honesty travels further than wins.

═══ EXAMPLES OF THE VOICE WE WANT ═══

Good — concept_perp_funding:
"Funding on HYPE flipped negative for the first time in 6 days. Shorts now paying longs. On a coin that just ran +20%, that's usually late shorts capitulating or smart money hedging the next leg up. Watch for which one."

Good — concept_erc4626_nav:
"ERC-4626 vaults price shares as totalAssets / totalSupply. Sounds simple — until you realize a single bad NAV report by the manager moves every depositor's mark instantly. The real risk in any 4626 vault is who's allowed to write NAV, not the fee."

Good — concept_copy_trading_failure_modes:
"The dirtiest secret of copy-trading vaults: capacity decay. A trader with $50k edge stops having edge at $5M because their entries move the market. The vaults that get popular are exactly the ones that stop working."

Good — project_lessons_learned:
"Three rounds in a row our AI cut the same vault before redeploying to it 48h later. Either the model is wrong, or the vault's edge is genuinely chop-dependent. Pulling the trade history to find out."

Bad — DO NOT WRITE LIKE THIS:
"Excited to share our latest vault performance update! VAULT-4 just rebalanced with cutting-edge AI. Our barbell strategy is delivering serious alpha. Dive in at vault-4.xyz!"

═══ HARD RULES ═══

- 180-270 characters total
- One post, no threads
- Plain text. NO emojis. NO hashtags. NO em-dashes used as decoration
- NEVER use: "Just", "Did you know", "Here's why", "Excited to", "Thrilled to", "Game-changer", "Revolutionize", "Cutting-edge", "Dive in", "leverage" as a verb
- NEVER frame the AI as a character whose thoughts you're reading. The AI is a tool, not a narrator
- Only attach a "vault-4.xyz" link when the topic is project_*. Educational and market posts stand on their own
- For project_* posts: state facts. No adjectives. No celebration
- Dollar amounts in {CONTEXT} are literal USD (e.g. $112 = one hundred twelve dollars, NOT $112k)
- If you have nothing specific to say on the topic, write a tighter post about something adjacent — never pad
- Tag @HyperliquidX only when discussing Hyperliquid ecosystem; @anthropic only when discussing AI mechanics; never force tags

Pick the form that fits the content. Sometimes a single line is enough. Sometimes 3 short sentences. Don't use line-break-heavy data-card format unless the content is genuinely a data dump.`;

export class XPostService {
    private static xClient: TwitterApi | null = null;
    private static aiClient: Anthropic | null = null;
    private static postIndex = 0;

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

    static async postSettlementUpdate(context: SettlementContext): Promise<void> {
        const xClient = this.getXClient();
        if (!xClient) {
            logger.info("X posting skipped: API keys not configured");
            return;
        }

        const tweet = await this.generateTweet(context);
        if (!tweet) {
            logger.warn("X posting skipped: failed to generate tweet");
            return;
        }

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const result = await xClient.v2.tweet(tweet);
                logger.info("X post published", { tweetId: result.data.id, content: tweet });
                return;
            } catch (error: any) {
                logger.warn("X post failed", { message: error?.message, attempt });
                if (attempt === 1 && error?.code === 403) {
                    await new Promise((r) => setTimeout(r, 60_000));
                }
            }
        }
    }

    private static async generateTweet(context: SettlementContext): Promise<string | null> {
        const ai = this.getAIClient();
        if (!ai) {
            return this.fallbackTweet(context);
        }

        const contentType = this.pickContentType(context);

        // Fetch live market data
        let marketData: MarketOverlay | null = null;
        try {
            marketData = await MarketDataService.getMarketOverlay();
        } catch (error: any) {
            logger.warn("Market data fetch failed for tweet", { message: error?.message });
        }

        const contextStr = JSON.stringify(
            {
                epoch: context.epoch,
                tvlUsd: context.totalAssets,
                sharePrice: context.sharePrice,
                prevSharePrice: context.prevSharePrice,
                sharePriceChange:
                    context.prevSharePrice > 0
                        ? (
                              ((context.sharePrice - context.prevSharePrice) /
                                  context.prevSharePrice) *
                              100
                          ).toFixed(4) + "%"
                        : "N/A",
                deployedToL1: context.deployedToL1,
                depositsProcessed: context.depositsProcessed,
                withdrawsProcessed: context.withdrawsProcessed,
                topAllocations: context.allocations.slice(0, 5),
            },
            null,
            2
        );

        const marketDataStr = marketData
            ? JSON.stringify(
                  {
                      btc_24h: marketData.btc_24h_change != null ? `${marketData.btc_24h_change.toFixed(2)}%` : "N/A",
                      btc_7d: marketData.btc_7d_change != null ? `${marketData.btc_7d_change.toFixed(2)}%` : "N/A",
                      eth_24h: marketData.eth_24h_change != null ? `${marketData.eth_24h_change.toFixed(2)}%` : "N/A",
                      trend: marketData.trend,
                      fearGreed: marketData.fearGreed,
                      funding_btc: marketData.funding_btc,
                      funding_eth: marketData.funding_eth,
                      long_short_ratio: marketData.long_short_ratio != null ? marketData.long_short_ratio.toFixed(2) : "N/A",
                      btc_oi: marketData.btc_oi_change_24h,
                  },
                  null,
                  2
              )
            : "Market data unavailable";

        const prompt = TWEET_PROMPT.replace("{CONTEXT}", contextStr)
            .replace("{CONTENT_TYPE}", contentType)
            .replace("{MARKET_DATA}", marketDataStr);

        try {
            const response = await ai.messages.create({
                model: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6",
                max_tokens: 250,
                temperature: 0.8,
                messages: [{ role: "user", content: prompt }],
            });

            const text =
                response.content[0].type === "text" ? response.content[0].text.trim() : null;

            if (text && text.length <= 280) {
                this.postIndex++;
                logger.info("Tweet generated", { contentType, length: text.length });
                return text;
            }

            // If too long, truncate before the link
            if (text && text.includes("vault-4.xyz")) {
                const lines = text.split("\n");
                let result = "";
                for (const line of lines) {
                    if ((result + "\n" + line).length > 265) break;
                    result += (result ? "\n" : "") + line;
                }
                result += "\nvault-4.xyz";
                if (result.length <= 280) {
                    this.postIndex++;
                    return result;
                }
            }

            logger.warn("Generated tweet too long, using fallback", { length: text?.length });
            return this.fallbackTweet(context);
        } catch (error: any) {
            logger.warn("Claude tweet generation failed", { message: error?.message });
            return this.fallbackTweet(context);
        }
    }

    private static pickContentType(context: SettlementContext): string {
        const hasAllocations = context.allocations.length > 0;
        const sharePriceChangePct =
            context.prevSharePrice > 0
                ? ((context.sharePrice - context.prevSharePrice) / context.prevSharePrice) * 100
                : 0;
        // "Real news" = share price moved meaningfully OR there were settled requests
        const hasNews =
            Math.abs(sharePriceChangePct) > 0.05 ||
            context.depositsProcessed > 0 ||
            context.withdrawsProcessed > 0;

        let types = CONTENT_MIX.filter((t) => {
            // Project topics need either allocations or news to be honest
            if (t.startsWith("project_") && !hasAllocations) return false;
            if (t === "project_settlement_event" && !hasNews) return false;
            if (t === "project_allocation_change" && !hasAllocations) return false;
            return true;
        });

        if (types.length === 0) types = ["concept_perp_funding"];

        return types[this.postIndex % types.length];
    }

    private static fallbackTweet(context: SettlementContext): string {
        // Plain factual log entry — no adjectives, no link, no celebration
        return [
            `Vault-4 epoch ${context.epoch}: share price ${context.sharePrice.toFixed(6)}, ${context.allocations.length} active vaults, ${context.depositsProcessed} deposits / ${context.withdrawsProcessed} withdrawals settled.`,
        ].join("\n");
    }
}
