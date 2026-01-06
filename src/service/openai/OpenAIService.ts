import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";
import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import { MarketDataService } from "./MarketDataService";
import type { VaultCandidate } from "../vaults/types";

type OpenAIRankedVault = {
    vaultAddress: string;
    reason?: string;
    score?: number;
};

export type OpenAIRanking = {
    model: string;
    highConfidence: OpenAIRankedVault[];
    lowConfidence: OpenAIRankedVault[];
    raw: string;
};

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.1";
const RAW_TEMPERATURE = Number(process.env.OPENAI_TEMPERATURE ?? 0.2);
const DEFAULT_TEMPERATURE = Number.isFinite(RAW_TEMPERATURE) ? RAW_TEMPERATURE : 0.2;
const RAW_MAX_CANDIDATES = Number(process.env.OPENAI_MAX_CANDIDATES ?? 80);
const MAX_CANDIDATES = Number.isFinite(RAW_MAX_CANDIDATES) ? RAW_MAX_CANDIDATES : 80;
const RAW_MAX_TRADES = Number(process.env.OPENAI_MAX_TRADES_PER_VAULT ?? 250);
const MAX_TRADES = Number.isFinite(RAW_MAX_TRADES) ? RAW_MAX_TRADES : 250;
const RAW_MAX_POSITIONS = Number(process.env.OPENAI_MAX_POSITIONS_PER_VAULT ?? 30);
const MAX_POSITIONS = Number.isFinite(RAW_MAX_POSITIONS) ? RAW_MAX_POSITIONS : 30;
const RAW_DATA_CONCURRENCY = Number(process.env.OPENAI_DATA_CONCURRENCY ?? 3);
const DATA_CONCURRENCY = Number.isFinite(RAW_DATA_CONCURRENCY)
    ? Math.max(1, Math.floor(RAW_DATA_CONCURRENCY))
    : 3;

const PROMPT_PATH = path.join(__dirname, "prompts", "vault-ranking.md");

export class OpenAIService {
    private static client: OpenAI | null = null;
    private static promptCache: string | null = null;

    static isConfigured(): boolean {
        return Boolean(process.env.OPENAI_API_KEY);
    }

    static async rankVaults(
        candidates: VaultCandidate[],
        totalCount: number,
        highConfidenceCount: number
    ): Promise<OpenAIRanking | null> {
        if (!this.isConfigured()) {
            logger.warn("OpenAI API key missing, skipping AI ranking");
            return null;
        }
        if (!candidates.length) return null;

        const client = this.getClient();
        const prompt = this.getPromptTemplate();
        const vaultsPayload = await buildVaultPayload(
            candidates.slice(0, MAX_CANDIDATES),
            {
                maxTrades: MAX_TRADES,
                maxPositions: MAX_POSITIONS,
                concurrency: DATA_CONCURRENCY,
            }
        );
        const marketData = await MarketDataService.getMarketOverlay();
        const userPrompt = `market_data = ${JSON.stringify(
            marketData
        )}\n\nvaults_json = ${JSON.stringify(vaultsPayload)}`;

        try {
            const response = await client.chat.completions.create({
                model: DEFAULT_MODEL,
                temperature: DEFAULT_TEMPERATURE,
                messages: [
                    { role: "system", content: prompt },
                    { role: "user", content: userPrompt },
                ],
            });

            const content = response.choices?.[0]?.message?.content?.trim() ?? "";
            const parsed = parseJsonPayload(content);
            if (!parsed) {
                logger.warn("OpenAI response was not valid JSON");
                return null;
            }
            const top10 = normalizeTop10(parsed.top10 ?? parsed.top_10);
            if (!top10.length) {
                logger.warn("OpenAI response missing top10 array");
                return null;
            }
            const ranked = top10
                .map((entry) => ({
                    vaultAddress: entry.address ?? entry.vaultAddress ?? "",
                    reason: entry.why_now,
                    score: entry.score_market,
                    rank: entry.rank,
                }))
                .filter((entry) => Boolean(entry.vaultAddress));

            const ordered = ranked.some((entry) => Number.isFinite(entry.rank))
                ? ranked
                      .slice()
                      .sort(
                          (a, b) =>
                              (Number(a.rank) || 0) - (Number(b.rank) || 0)
                      )
                : ranked;

            const high = ordered.slice(0, highConfidenceCount);
            const low = ordered.slice(highConfidenceCount, totalCount);
            if (!high.length || high.length + low.length < totalCount) {
                logger.warn("OpenAI response returned insufficient ranked vaults");
                return null;
            }

            return {
                model: DEFAULT_MODEL,
                highConfidence: normalizeRankedVaults(high),
                lowConfidence: normalizeRankedVaults(low),
                raw: content,
            };
        } catch (error: any) {
            logger.warn("OpenAI ranking failed", { message: error?.message });
            return null;
        }
    }

    private static getClient(): OpenAI {
        if (!this.client) {
            this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        }
        return this.client;
    }

    private static getPromptTemplate(): string {
        if (!this.promptCache) {
            this.promptCache = fs.readFileSync(PROMPT_PATH, "utf8");
        }
        return this.promptCache;
    }
}

function normalizeTop10(entries: any): any[] {
    return Array.isArray(entries) ? entries : [];
}

function normalizeRankedVaults(entries: any[]): OpenAIRankedVault[] {
    return entries
        .map((entry) => ({
            vaultAddress: String(entry.vaultAddress ?? "").trim(),
            reason: entry.reason ? String(entry.reason).trim() : undefined,
            score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : undefined,
        }))
        .filter((entry) => Boolean(entry.vaultAddress));
}

type VaultTrade = {
    time: number;
    dir: string;
    closedPnl: number;
    fee: number;
};

type VaultPayload = {
    vault: {
        summary: {
            name: string;
            vaultAddress: string;
            tvl: number;
        };
        pnls: any;
    };
    trades: VaultTrade[];
    accountSummary: {
        assetPositions: any[];
    };
};

async function buildVaultPayload(
    candidates: VaultCandidate[],
    options: { maxTrades: number; maxPositions: number; concurrency: number }
): Promise<VaultPayload[]> {
    return mapWithConcurrency(candidates, options.concurrency, async (candidate) => {
        const vaultAddress = candidate.vaultAddress;
        const [trades, accountSummary] = await Promise.all([
            HyperliquidConnector.getVaultTrades(vaultAddress, 7, options.maxTrades),
            HyperliquidConnector.getVaultAccountSummary(vaultAddress),
        ]);
        const positions = Array.isArray(accountSummary?.assetPositions)
            ? accountSummary.assetPositions.slice(0, options.maxPositions)
            : [];
        return {
            vault: {
                summary: {
                    name: candidate.name,
                    vaultAddress: candidate.vaultAddress,
                    tvl: candidate.tvl,
                },
                pnls: candidate.raw?.pnls ?? [],
            },
            trades,
            accountSummary: {
                assetPositions: positions,
            },
        };
    });
}

async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let index = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
        while (true) {
            const current = index;
            index += 1;
            if (current >= items.length) break;
            results[current] = await worker(items[current], current);
        }
    });
    await Promise.all(workers);
    return results;
}

function parseJsonPayload(content: string): any | null {
    if (!content) return null;
    try {
        return JSON.parse(content);
    } catch {
        const start = content.indexOf("{");
        const end = content.lastIndexOf("}");
        if (start === -1 || end === -1 || end <= start) return null;
        try {
            return JSON.parse(content.slice(start, end + 1));
        } catch {
            return null;
        }
    }
}
