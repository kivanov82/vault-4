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
const MAX_TRADES = Number(process.env.OPENAI_MAX_TRADES_PER_VAULT ?? 100);
const MAX_POSITIONS = Number(process.env.OPENAI_MAX_POSITIONS_PER_VAULT ?? 30);

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
        const vaultsPayload = await buildVaultPayload(candidates, {
            maxTrades: MAX_TRADES,
            maxPositions: MAX_POSITIONS,
        });
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
    options: { maxTrades: number; maxPositions: number }
): Promise<VaultPayload[]> {
    const payload: VaultPayload[] = [];
    for (const candidate of candidates) {
        const vaultAddress = candidate.vaultAddress;
        const trades = await HyperliquidConnector.getVaultTrades(
                vaultAddress,
                30,
                options.maxTrades
            );
        const accountSummary =  await HyperliquidConnector.getVaultAccountSummary(vaultAddress);
        const details = HyperliquidConnector.getVaultDetails(vaultAddress);

        const positions = Array.isArray(accountSummary?.assetPositions)
            ? accountSummary.assetPositions.slice(0, options.maxPositions)
            : [];
        const pnlSeries =
            buildPnlsFromDetails(details) ??
            normalizePnls(candidate.raw?.pnls, Date.now());
        payload.push({
            vault: {
                summary: {
                    name: candidate.name,
                    vaultAddress: candidate.vaultAddress,
                    tvl: candidate.tvl,
                },
                pnls: pnlSeries,
            },
            trades,
            accountSummary: {
                assetPositions: positions,
            },
        });
    }
    return payload;
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

type PnlPoint = [number, number];
type PnlSeries = [string, PnlPoint[]];

function buildPnlsFromDetails(details: any): PnlSeries[] | null {
    const portfolio = details?.portfolio;
    if (!Array.isArray(portfolio)) return null;
    const mapped = portfolio
        .map((entry: any) => {
            if (!Array.isArray(entry) || entry.length < 2) return null;
            const period = String(entry[0] ?? "");
            const pnlHistory = entry[1]?.pnlHistory;
            const points = normalizePnlHistory(pnlHistory);
            if (!period || !points.length) return null;
            return [period, points] as PnlSeries;
        })
        .filter((entry): entry is PnlSeries => Boolean(entry));
    return mapped.length ? mapped : null;
}

function normalizePnls(raw: any, nowMs: number): any[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((entry) => {
            if (!Array.isArray(entry) || entry.length < 2) return null;
            const period = String(entry[0] ?? "");
            const values = Array.isArray(entry[1]) ? entry[1] : [];
            const numeric = values
                .map((value: any) => Number(value))
                .filter((value: number) => Number.isFinite(value));
            if (!period || !numeric.length) return null;
            const points = buildSyntheticPoints(period, numeric, nowMs);
            return [period, points];
        })
        .filter(Boolean);
}

function normalizePnlHistory(raw: any): PnlPoint[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((entry) => {
            if (!Array.isArray(entry) || entry.length < 2) return null;
            const ts = normalizeTimestamp(entry[0]);
            const value = Number(entry[1]);
            if (!Number.isFinite(ts) || !Number.isFinite(value)) return null;
            return [ts, value] as PnlPoint;
        })
        .filter((entry): entry is PnlPoint => Boolean(entry))
        .sort((a, b) => a[0] - b[0]);
}

function normalizeTimestamp(value: any): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return NaN;
    return num < 1e12 ? num * 1000 : num;
}


function buildSyntheticPoints(
    period: string,
    values: number[],
    nowMs: number
): PnlPoint[] {
    const windowMs = periodWindowMs(period, values.length);
    if (values.length === 1) {
        return [[nowMs, values[0]]];
    }
    const start = nowMs - windowMs;
    const step = windowMs / (values.length - 1);
    return values.map((value, index) => [
        Math.round(start + step * index),
        value,
    ]);
}

function periodWindowMs(period: string, count: number): number {
    const day = 24 * 60 * 60 * 1000;
    if (period === "day") return day;
    if (period === "week") return 7 * day;
    if (period === "month") return 30 * day;
    if (period === "allTime") return Math.max(365 * day, count * 7 * day);
    if (period === "perpDay") return day;
    if (period === "perpWeek") return 7 * day;
    if (period === "perpMonth") return 30 * day;
    if (period === "perpAllTime") return Math.max(365 * day, count * 7 * day);
    return Math.max(30 * day, count * day);
}
