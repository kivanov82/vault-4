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
    "portfolio_snapshot",
    "hot_take",
] as const;

// Visual format templates — each post should look different
const FORMAT_STYLES = [
    "clean_prose",       // Short punchy paragraph, no special formatting
    "data_card",         // Key-value pairs with labels, like a terminal readout
    "contrast",          // "X does Y. We do Z." — comparison format
    "question_answer",   // Open with a provocative question, then answer it
    "single_stat",       // Lead with one striking number, explain it
    "narrative",         // Mini story: "Yesterday the AI did X because Y"
] as const;

const TWEET_PROMPT = `You are the social media voice for VAULT-4 (@vault4_xyz), an AI-managed DeFi vault on Hyperliquid.

VAULT-4 uses Claude AI to rank 100+ Hyperliquid vaults, allocates capital with a barbell strategy (70-80% high conviction, 20-30% exploratory), and rebalances every 48 hours. It's an ERC-4626 vault on HyperEVM with daily settlement at 3PM CET.

Your tone: sharp, technical but accessible, crypto-native. Think: a quant fund's engineering blog meets crypto twitter. Confident but not arrogant. Occasionally provocative.

Current portfolio data:
{CONTEXT}

Current market data:
{MARKET_DATA}

Content type: {CONTENT_TYPE}
Visual format: {FORMAT_STYLE}

═══ CONTENT TYPE GUIDELINES ═══

vault_spotlight: Spotlight one vault from the allocation. What strategy does it run? Why did the AI score it high? Name the vault. Be specific about its edge.

ai_decision: Narrate a specific decision — an exit, a new entry, a reweight. WHY did the AI do it? Reference the scoring system or barbell logic. Make it feel like you're reading the AI's thought process.

educational_erc4626: Teach something about ERC-4626 — share math, NAV calculation, composability. Connect to VAULT-4. Tag @ethereum or @opaboracle when relevant.

educational_ai_agents: AI agents in DeFi — ERC-8004, x402 payments, autonomous portfolio management. Tag @anthropic, @coinaboracle, or @hypaboracle when relevant. Position VAULT-4 as a working example, not a pitch.

performance_update: Only when share price went up. Lead with the number. Compare to idle USDC or market benchmark. Don't sugarcoat flat periods.

how_it_works: One specific mechanic explained clearly: queue system, instant withdrawals, sweep-to-L1, NAV reporting, performance fees, barbell allocation math. Make it concrete.

market_commentary: React to the live market data. BTC trend, fear/greed, funding rates, OI. Connect it to what an AI allocator should do in this environment. Tag @HyperliquidX when discussing their ecosystem. Cite actual numbers.

portfolio_snapshot: Quick portfolio overview — top 3 vaults, total deployed, active count. Format like a dashboard readout. Use the data card format.

hot_take: One strong, opinionated statement about DeFi, AI agents, or vault management. Contrarian is good. Back it up with one line of reasoning.

═══ FORMAT STYLE GUIDELINES ═══

clean_prose: 2-3 short sentences. No line breaks between them. Punchy and direct.

data_card: Use line breaks and labels. Example:
VAULT-4 | Epoch 10
Top vault: OnlyShorts (+4.2%)
Deployed: $685 across 9 vaults
Rebalance: 12h
vault-4.xyz

contrast: "Most funds do X. VAULT-4 does Y." — set up a comparison that makes the point.

question_answer: Start with a real question. Answer it in 1-2 lines.

single_stat: Lead with ONE number that catches attention. "9 vaults. $685 deployed. One AI scoring them all every 48 hours." Then one line of context.

narrative: Tell a micro-story. "The AI exited X vault after spotting Y. Reallocated to Z." Make it feel like a live decision log.

═══ TAGGING RULES ═══

Tag accounts ONLY when genuinely relevant to the content:
- @HyperliquidX — when discussing Hyperliquid vaults, ecosystem, or L1
- @anthropic — when discussing Claude AI, AI decision-making
- @base — when discussing x402 payments on Base
- @ethereum — when discussing ERC-4626, ERC-8004 standards
- Individual vault names — when spotlighting a specific vault's strategy
- Do NOT force tags. Skip tagging entirely if it doesn't fit naturally.
- Max 1-2 tags per post.

═══ RULES ═══

- MUST be between 150-260 characters (leave room for link). Too short = boring. Use the space.
- One tweet only, no threads
- End with "vault-4.xyz" on its own line
- Each post MUST look visually different from a generic "AI vault update" post
- Dollar amounts in the data are actual USD (e.g. $112 means one hundred twelve dollars, NOT $112k)
- Sound like a real person, not a bot. Vary rhythm. Be direct.
- NO: "Just", "Did you know", "Here's why", "Excited to", "Thrilled to", "Game-changer", "Revolutionizing", "Cutting-edge", "Dive in", emojis, hashtags
- Be specific — reference actual vault names, numbers, percentages from the data
- Have an opinion or a surprising angle. Don't be generic.
- If performance is flat or negative, do NOT post about performance
- CRITICAL: Do not repeat the same structure as previous posts. Every tweet should feel fresh.`;

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
        const formatStyle = this.pickFormatStyle();

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
            .replace("{FORMAT_STYLE}", formatStyle)
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
                logger.info("Tweet generated", { contentType, formatStyle, length: text.length });
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

        let types = CONTENT_TYPES.filter((t) => {
            if (t === "performance_update" && !hasGain) return false;
            if (t === "vault_spotlight" && !hasAllocations) return false;
            if (t === "ai_decision" && !hasAllocations) return false;
            if (t === "portfolio_snapshot" && !hasAllocations) return false;
            return true;
        });

        if (types.length === 0) types = ["how_it_works"];

        return types[this.postIndex % types.length];
    }

    private static pickFormatStyle(): string {
        // Rotate format independently from content type for max variety
        return FORMAT_STYLES[(this.postIndex + 3) % FORMAT_STYLES.length];
    }

    private static fallbackTweet(context: SettlementContext): string {
        const top = context.allocations[0];
        const topLine = top ? `Top: ${top.vault} (${(top.roePct ?? 0) >= 0 ? "+" : ""}${(top.roePct ?? 0).toFixed(1)}%)` : "";
        return [
            `VAULT-4 | Epoch ${context.epoch}`,
            `$${context.totalAssets.toFixed(0)} deployed across ${context.allocations.length} vaults`,
            topLine,
            `Share: ${context.sharePrice.toFixed(6)}`,
            ``,
            `vault-4.xyz`,
        ].filter(Boolean).join("\n");
    }
}
