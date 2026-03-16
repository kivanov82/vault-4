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

const CONTENT_TYPES = [
    "vault_spotlight",
    "ai_decision",
    "educational_erc4626",
    "educational_ai_agents",
    "performance_update",
    "how_it_works",
    "market_commentary",
] as const;

const TWEET_PROMPT = `You are the social media voice for VAULT-4, an AI-managed DeFi vault on Hyperliquid.

VAULT-4 uses Claude AI to rank 100+ Hyperliquid vaults, allocates capital with a barbell strategy (70-80% high conviction, 20-30% exploratory), and rebalances every 48 hours. It's an ERC-4626 vault on HyperEVM with daily settlement at 3PM CET.

Your tone: sharp, technical but accessible, crypto-native. No emojis. No hashtags. No "gm". Think: a quant fund's engineering blog meets crypto twitter. Confident but not arrogant.

Current portfolio data:
{CONTEXT}

Content type for this post: {CONTENT_TYPE}

Content type guidelines:
- vault_spotlight: Highlight the top performing vault in the allocation. What does it do? Why did the AI pick it? Keep it specific.
- ai_decision: Explain a decision the AI made — an exit, a new entry, or why certain vaults scored high. Reference the barbell strategy or scoring system.
- educational_erc4626: Explain something about ERC-4626 vaults, tokenized shares, or on-chain settlement. Connect it to what VAULT-4 does. Reference how AI agents and composable DeFi intersect.
- educational_ai_agents: Talk about AI agents in DeFi — ERC-8004 trust layer, x402 payments, autonomous portfolio management. Position VAULT-4 as an example.
- performance_update: Only if share price increased. Focus on the result, not just numbers. Compare to holding idle USDC.
- how_it_works: Explain one specific mechanic: the queue system, instant withdrawals, sweep-to-L1, NAV calculation, performance fees, etc.
- market_commentary: React to the current market conditions provided below. Connect market movement (BTC trend, fear/greed, funding rates, OI shifts) to what it means for vault allocation. Be specific — cite actual numbers. Show that the AI is reading the market, not just managing a portfolio.

Current market data:
{MARKET_DATA}

Rules:
- Max 260 characters (leave room for link)
- One tweet only, no threads
- End with "vault-4.xyz" on its own line
- Sound like a real person, not a bot. Vary rhythm. Be direct.
- NO: "Just", "Did you know", "Here's why", "Excited to", "Thrilled to", "Game-changer", "Revolutionizing", "Cutting-edge", "Dive in", emojis, hashtags
- Be specific, reference actual data when possible
- Have an opinion or a surprising angle. Don't be generic.
- If performance is flat or negative, do NOT post about performance — pick a different angle`;

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

        try {
            const result = await xClient.v2.tweet(tweet);
            logger.info("X post published", { tweetId: result.data.id, content: tweet });
        } catch (error: any) {
            logger.warn("X post failed", { message: error?.message });
        }
    }

    private static async generateTweet(context: SettlementContext): Promise<string | null> {
        const ai = this.getAIClient();
        if (!ai) {
            return this.fallbackTweet(context);
        }

        // Rotate content type
        const contentType = this.pickContentType(context);

        // Fetch live market data for context-aware posts
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
                model: process.env.CLAUDE_MODEL ?? "claude-3-haiku-20240307",
                max_tokens: 200,
                messages: [{ role: "user", content: prompt }],
            });

            const text =
                response.content[0].type === "text" ? response.content[0].text.trim() : null;

            if (text && text.length <= 280) {
                this.postIndex++;
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
        const hasGain = context.sharePrice > context.prevSharePrice;
        const hasAllocations = context.allocations.length > 0;

        // If positive performance, allow performance_update
        // Otherwise filter it out
        let types = CONTENT_TYPES.filter((t) => {
            if (t === "performance_update" && !hasGain) return false;
            if (t === "vault_spotlight" && !hasAllocations) return false;
            if (t === "ai_decision" && !hasAllocations) return false;
            return true;
        });

        if (types.length === 0) types = ["how_it_works"];

        return types[this.postIndex % types.length];
    }

    private static fallbackTweet(context: SettlementContext): string {
        return [
            `VAULT-4 | Epoch ${context.epoch}`,
            `TVL: $${context.totalAssets.toFixed(2)}`,
            `Share Price: ${context.sharePrice.toFixed(6)}`,
            `Active vaults: ${context.allocations.length}`,
            ``,
            `vault-4.xyz`,
        ].join("\n");
    }
}
