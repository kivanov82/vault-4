import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../utils/logger";
import { MarketDataService } from "../claude/MarketDataService";

const TOPICS: Record<string, string> = {
    ai_trading: `Write an educational article about AI-powered automated trading in DeFi.
Cover: how AI agents analyze vault performance metrics, the two-stage scoring/ranking approach,
barbell allocation strategy (high conviction vs exploratory), automated rebalancing cycles,
and why removing human emotion from portfolio decisions matters.
Reference VAULT-4 as a concrete example built on Hyperliquid.
Mention how Claude AI evaluates TVL, trade frequency, PnL history, drawdown, and vault age.`,

    erc8004: `Write an educational article about ERC-8004: the Trustless AI Agents standard on Ethereum.
Cover: the three registries (Identity, Reputation, Validation), why AI agents need on-chain identity,
how trust is established without centralized authorities, the role of staking/slashing in validation,
and how this enables an autonomous agent economy.
Connect it to DeFi: AI agents that manage funds need verifiable track records.
Reference VAULT-4 as an example of an AI agent that could benefit from ERC-8004 registration.`,

    x402: `Write an educational article about x402: HTTP 402 Payment Required for AI agent micropayments.
Cover: the problem (AI agents need to pay for API access programmatically), how x402 works
(payment headers in HTTP requests), the vision of agent-to-agent commerce,
and why this matters for DeFi data access.
Use the example: an AI trading agent paying per-request for vault performance data
or alpha signals. Reference VAULT-4's /api/strategy endpoint as infrastructure that
AI agents could consume.`,

    erc4626: `Write an educational article about ERC-4626: the Tokenized Vault Standard.
Cover: what ERC-4626 standardizes (deposit/withdraw/share accounting), why composability matters,
how share price is calculated (totalAssets/totalSupply), the queue-based settlement pattern
for managed vaults, instant vs queued withdrawals, and NAV reporting.
Reference VAULT-4 as a concrete implementation on HyperEVM with daily settlement at 3PM CET.`,

    hyperliquid_vaults: `Write an educational article about the Hyperliquid vault ecosystem.
Cover: what Hyperliquid vaults are (managed trading accounts with public track records),
how they differ from traditional DeFi yield vaults, the transparency of on-chain trading history,
metrics that matter (TVL, PnL, drawdown, trade frequency, age),
and why automated allocation across multiple vaults reduces single-manager risk.
Reference VAULT-4 as an AI layer on top of this ecosystem.`,
};

const ARTICLE_SYSTEM_PROMPT = `You write articles for the VAULT-4 blog. VAULT-4 is an AI-managed DeFi vault on Hyperliquid.

WRITING STYLE — THIS IS CRITICAL:
Write like a senior engineer writing a blog post, not like a marketing team. Think: Stripe's engineering blog, or a well-written HackerNews comment.

Rules for sounding human:
- Start mid-thought. Jump straight into the interesting part. Never open with "In the world of..." or "The landscape of..." or any throat-clearing.
- Use "I" and "we" naturally. Have opinions. "We think X is overrated because Y."
- Vary sentence length aggressively. Some sentences are three words. Others run long with multiple clauses because the idea needs room to breathe.
- Use concrete examples over abstractions. Don't say "enhanced efficiency" — say "settlement went from 3 hours to 40 seconds."
- Include one contrarian or surprising take. Something the reader won't expect.
- Use casual transitions: "Here's the thing.", "So what?", "The trick is..."
- Occasional sentence fragments. For emphasis.
- Reference specific numbers, addresses, function names when relevant.
- NO: "In conclusion", "It's worth noting", "It's important to", "Let's dive in", "At its core", "harness", "leverage", "cutting-edge", "game-changer", "paradigm", "revolutionize", "empower", "navigate", "landscape", "robust", "seamless", "comprehensive"
- NO numbered lists of benefits. Weave points into prose.
- Headers should be short and punchy, not SEO-optimized. "The Queue Problem" not "Understanding the Challenges of Queue-Based Settlement Systems"

Format:
- Markdown with ## headers
- 800-1200 words
- End with one line: "More at vault-4.xyz" — no fanfare

About VAULT-4:
- AI-managed ERC-4626 vault on HyperEVM (Hyperliquid's EVM chain)
- Uses Claude AI to rank 100+ Hyperliquid vaults in a two-stage process
- Barbell allocation: 70-80% high conviction, 20-30% exploratory
- Automated 48-hour rebalancing cycles
- Daily settlement at 3PM CET with on-chain NAV reporting
- Non-custodial: users deposit USDC, receive V4FUND shares
- Contract: 0xb6099d4545156f8ACA1A8Ea7CAA0762D81697809`;

export class ArticleService {
    private static client: Anthropic | null = null;

    private static getClient(): Anthropic {
        if (!this.client) {
            this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        }
        return this.client;
    }

    private static async getMarketContext(): Promise<string> {
        try {
            const m = await MarketDataService.getMarketOverlay();
            return `Current market snapshot (use sparingly for color, don't build the article around it):
BTC 24h: ${m.btc_24h_change?.toFixed(2) ?? "N/A"}%, 7d: ${m.btc_7d_change?.toFixed(2) ?? "N/A"}%
ETH 24h: ${m.eth_24h_change?.toFixed(2) ?? "N/A"}%
Trend: ${m.trend}, Fear/Greed: ${m.fearGreed ?? "N/A"}
BTC funding: ${m.funding_btc ?? "N/A"}, ETH funding: ${m.funding_eth ?? "N/A"}`;
        } catch {
            return "";
        }
    }

    static getAvailableTopics(): string[] {
        return Object.keys(TOPICS);
    }

    static async generateArticle(topic: string): Promise<{ title: string; body: string } | null> {
        const topicPrompt = TOPICS[topic];
        if (!topicPrompt) {
            logger.warn("Unknown article topic", { topic, available: Object.keys(TOPICS) });
            return null;
        }

        try {
            const response = await this.getClient().messages.create({
                model: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6",
                max_tokens: 2000,
                system: ARTICLE_SYSTEM_PROMPT,
                messages: [
                    {
                        role: "user",
                        content: `${topicPrompt}\n\n${await this.getMarketContext()}\nRespond with the article in this format:\nTITLE: <article title>\n\n<article body in markdown>`,
                    },
                ],
            });

            const text = response.content[0].type === "text" ? response.content[0].text.trim() : "";

            // Parse title from first line
            const titleMatch = text.match(/^TITLE:\s*(.+)/);
            const title = titleMatch ? titleMatch[1].trim() : `VAULT-4: ${topic.replace(/_/g, " ")}`;
            const body = text.replace(/^TITLE:.*\n+/, "").trim();

            logger.info("Article generated", { topic, title, length: body.length });
            return { title, body };
        } catch (error: any) {
            logger.error("Article generation failed", { topic, message: error?.message });
            return null;
        }
    }
}
