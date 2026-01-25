import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";
import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import { MarketDataService } from "./MarketDataService";
import type {
    SuggestedAllocations,
    SuggestedAllocationTarget,
    VaultCandidate,
} from "../vaults/types";

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
    suggestedAllocations?: SuggestedAllocations;
    allocationMap?: Record<string, number>;
};

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.1";
const RAW_TEMPERATURE = Number(process.env.OPENAI_TEMPERATURE ?? 0.2);
const DEFAULT_TEMPERATURE = Number.isFinite(RAW_TEMPERATURE) ? RAW_TEMPERATURE : 0.2;
const MAX_TRADES = Number(process.env.OPENAI_MAX_TRADES_PER_VAULT ?? 50);
const MAX_POSITIONS = Number(process.env.OPENAI_MAX_POSITIONS_PER_VAULT ?? 30);
const MAX_PNL_POINTS = Number(process.env.OPENAI_MAX_PNL_POINTS ?? 60);
const BATCH_SIZE = Number(process.env.OPENAI_BATCH_SIZE ?? 20);

const PROMPT_PATH = path.join(__dirname, "prompts", "vault-ranking.md");
const SCORING_PROMPT_PATH = path.join(__dirname, "prompts", "vault-scoring.md");
const DATA_DELAY_MS = Number(process.env.HYPERLIQUID_DATA_REQUEST_DELAY_MS ?? 200);

type ScoredVault = {
    vaultAddress: string;
    name: string;
    score: number;
    reason?: string;
    candidate: VaultCandidate;
};

export class OpenAIService {
    private static client: OpenAI | null = null;
    private static promptCache: string | null = null;
    private static scoringPromptCache: string | null = null;

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

        const marketData = await MarketDataService.getMarketOverlay();
        const alreadyExposed = await getAlreadyExposedVaults();

        // Stage 1: Score vaults in batches
        const batches = chunkArray(candidates, BATCH_SIZE);
        logger.info("Starting batched vault scoring", {
            totalCandidates: candidates.length,
            batchSize: BATCH_SIZE,
            batchCount: batches.length,
        });

        const batchResults = await Promise.all(
            batches.map((batch, index) =>
                this.scoreVaultBatch(batch, marketData, alreadyExposed, index)
            )
        );

        const allScored = batchResults
            .flat()
            .filter((v): v is ScoredVault => v !== null)
            .sort((a, b) => b.score - a.score);

        if (!allScored.length) {
            logger.warn("No vaults scored in Stage 1");
            return null;
        }

        logger.info("Stage 1 scoring complete", {
            scoredCount: allScored.length,
            topScore: allScored[0]?.score,
            bottomScore: allScored[allScored.length - 1]?.score,
        });

        // Stage 2: Final ranking of top candidates
        const topCandidates = allScored.slice(0, Math.max(totalCount * 2, 20));
        const topVaultCandidates = topCandidates.map((s) => s.candidate);

        return this.finalRanking(
            topVaultCandidates,
            marketData,
            alreadyExposed,
            totalCount,
            highConfidenceCount
        );
    }

    static async scoreVaultBatch(
        batch: VaultCandidate[],
        marketData: any,
        alreadyExposed: string[],
        batchIndex: number
    ): Promise<ScoredVault[]> {
        const client = this.getClient();
        const prompt = this.getScoringPromptTemplate();

        const vaultsPayload = await buildVaultPayload(batch, {
            maxTrades: MAX_TRADES,
            maxPositions: MAX_POSITIONS,
        });

        const userPrompt = `market_data = ${JSON.stringify(marketData)}

already_exposed = ${JSON.stringify(alreadyExposed)}

vaults_json = ${JSON.stringify(vaultsPayload)}`;

        try {
            logger.info("Scoring batch", {
                batchIndex,
                vaultCount: batch.length,
            });

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

            if (!parsed || !Array.isArray(parsed.scores)) {
                logger.warn("Batch scoring response invalid", {
                    batchIndex,
                    responsePreview: content.slice(0, 500),
                    responseLength: content.length,
                    parsedType: typeof parsed,
                    hasScoresArray: parsed ? Array.isArray(parsed.scores) : false,
                });
                return [];
            }

            const scored: ScoredVault[] = [];
            const scoredAddresses = new Set<string>();
            for (const entry of parsed.scores) {
                const address = String(entry.address ?? entry.vaultAddress ?? "").toLowerCase();
                const candidate = batch.find(
                    (c) => c.vaultAddress.toLowerCase() === address
                );
                if (!candidate) continue;

                scoredAddresses.add(address);
                scored.push({
                    vaultAddress: address,
                    name: candidate.name,
                    score: Number(entry.score) || 0,
                    reason: entry.reason ?? entry.why,
                    candidate,
                });
            }

            // Add missing vaults with default score of 25 (below average)
            for (const candidate of batch) {
                const addr = candidate.vaultAddress.toLowerCase();
                if (!scoredAddresses.has(addr)) {
                    logger.warn("Vault missing from batch scores, adding with default", {
                        name: candidate.name,
                        batchIndex,
                    });
                    scored.push({
                        vaultAddress: addr,
                        name: candidate.name,
                        score: 25,
                        reason: "Not scored by AI - using default",
                        candidate,
                    });
                }
            }

            logger.info("Batch scored", {
                batchIndex,
                scoredCount: scored.length,
                avgScore: scored.length
                    ? Math.round(scored.reduce((sum, s) => sum + s.score, 0) / scored.length)
                    : 0,
            });

            return scored;
        } catch (error: any) {
            logger.warn("Batch scoring failed", {
                batchIndex,
                message: error?.message,
            });
            return [];
        }
    }

    private static async finalRanking(
        candidates: VaultCandidate[],
        marketData: any,
        alreadyExposed: string[],
        totalCount: number,
        highConfidenceCount: number
    ): Promise<OpenAIRanking | null> {
        const client = this.getClient();
        const prompt = this.getPromptTemplate();

        const vaultsPayload = await buildVaultPayload(candidates, {
            maxTrades: MAX_TRADES,
            maxPositions: MAX_POSITIONS,
        });

        const userPrompt = `market_data = ${JSON.stringify(marketData)}

already_exposed = ${JSON.stringify(alreadyExposed)}

vaults_json = ${JSON.stringify(vaultsPayload)}`;

        try {
            logger.info("Stage 2: Final ranking", {
                candidateCount: candidates.length,
            });

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
                logger.warn("OpenAI response was not valid JSON", {
                    responsePreview: content.slice(0, 500),
                    responseLength: content.length,
                    model: DEFAULT_MODEL,
                });
                return null;
            }
            const top10 = normalizeTop10(parsed.top10 ?? parsed.top_10);
            if (!top10.length) {
                logger.warn("OpenAI response missing top10 array");
                return null;
            }
            const suggestedAllocations = parseSuggestedAllocations(
                parsed.suggested_allocations ?? parsed.suggestedAllocations
            );

            if (suggestedAllocations) {
                logger.info("OpenAI barbell suggestion received", {
                    note: suggestedAllocations.barbellNote,
                    totalPct: suggestedAllocations.totalPct,
                    highPct: suggestedAllocations.highPct,
                    lowPct: suggestedAllocations.lowPct,
                });
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

            const allocationMap = suggestedAllocations
                ? buildAllocationMap(suggestedAllocations.targets)
                : undefined;

            logger.info("OpenAI ranking parsed", {
                model: DEFAULT_MODEL,
                total: ordered.length,
                suggestedAllocations: {
                    totalPct: suggestedAllocations?.totalPct,
                    highPct: suggestedAllocations?.highPct,
                    lowPct: suggestedAllocations?.lowPct,
                },
            });

            return {
                model: DEFAULT_MODEL,
                highConfidence: normalizeRankedVaults(high),
                lowConfidence: normalizeRankedVaults(low),
                raw: content,
                allocationMap,
                suggestedAllocations: suggestedAllocations ?? undefined,
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

    private static getScoringPromptTemplate(): string {
        if (!this.scoringPromptCache) {
            this.scoringPromptCache = fs.readFileSync(SCORING_PROMPT_PATH, "utf8");
        }
        return this.scoringPromptCache;
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
        await delayBetweenRequests();
        const accountSummary =
            await HyperliquidConnector.getVaultAccountSummary(vaultAddress);
        await delayBetweenRequests();
        const details = await HyperliquidConnector.getVaultDetails(vaultAddress);

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
            return [period, limitSeriesPoints(points, MAX_PNL_POINTS)] as PnlSeries;
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
            return [period, limitSeriesPoints(points, MAX_PNL_POINTS)];
        })
        .filter(Boolean);
}

function normalizePnlHistory(raw: any): PnlPoint[] {
    if (!Array.isArray(raw)) return [];
    const points = raw
        .map((entry) => {
            if (!Array.isArray(entry) || entry.length < 2) return null;
            const ts = normalizeTimestamp(entry[0]);
            const value = Number(entry[1]);
            if (!Number.isFinite(ts) || !Number.isFinite(value)) return null;
            return [ts, value] as PnlPoint;
        })
        .filter((entry): entry is PnlPoint => Boolean(entry))
        .sort((a, b) => a[0] - b[0]);
    return limitSeriesPoints(points, MAX_PNL_POINTS);
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

function limitSeriesPoints(points: PnlPoint[], max: number): PnlPoint[] {
    if (!Array.isArray(points) || !points.length) return [];
    if (!Number.isFinite(max) || max <= 0) return points;
    const limit = Math.max(0, Math.floor(max));
    if (points.length <= limit) return points;
    return points.slice(points.length - limit);
}

function parseSuggestedAllocations(raw: any): SuggestedAllocations | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const targetsRaw = Array.isArray(raw.targets) ? raw.targets : [];
    const targets = targetsRaw
        .map((entry) => parseAllocationTarget(entry))
        .filter((entry): entry is SuggestedAllocationTarget => Boolean(entry));
    if (!targets.length) return undefined;
    const totalPct = pickNumber(raw.total_pct ?? raw.totalPct ?? raw.total ?? 100, 100);
    const highPct = pickNumber(raw.high_pct ?? raw.highPct ?? raw.high ?? 0, 0);
    const lowPct = pickNumber(raw.low_pct ?? raw.lowPct ?? raw.low ?? 0, 0);
    const maxActive =
        Number.isFinite(Number(raw.max_active ?? raw.maxActive))
            ? Number(raw.max_active ?? raw.maxActive)
            : null;
    const highCount =
        Number.isFinite(Number(raw.high_count ?? raw.highCount))
            ? Number(raw.high_count ?? raw.highCount)
            : null;
    const lowCount =
        Number.isFinite(Number(raw.low_count ?? raw.lowCount))
            ? Number(raw.low_count ?? raw.lowCount)
            : null;
    const barbellNote =
        typeof raw.barbell_note === "string"
            ? raw.barbell_note
            : typeof raw.barbellNote === "string"
            ? raw.barbellNote
            : undefined;
    return {
        totalPct,
        maxActive,
        highPct,
        lowPct,
        highCount,
        lowCount,
        barbellNote,
        targets,
    };
}

function parseAllocationTarget(value: any): SuggestedAllocationTarget | null {
    if (!value || typeof value !== "object") return null;
    const rawAddress = String(
        value.vaultAddress ?? value.address ?? value.vault ?? ""
    ).trim();
    if (!rawAddress) return null;
    const allocationPct = pickNumber(
        value.allocation_pct ?? value.allocationPct ?? value.pct ?? 0,
        0
    );
    const rank = Number.isFinite(Number(value.rank)) ? Number(value.rank) : null;
    const confidence = normalizeConfidence(
        value.confidence ?? value.group ?? value.bucket
    );
    const notes =
        typeof value.notes === "string"
            ? value.notes
            : typeof value.reason === "string"
            ? value.reason
            : undefined;
    return {
        rank,
        vaultAddress: rawAddress.toLowerCase(),
        confidence,
        allocationPct,
        notes,
    };
}

function normalizeConfidence(value: any): "high" | "low" | null {
    if (!value || typeof value !== "string") return null;
    const normalized = value.toLowerCase();
    if (normalized.includes("high")) return "high";
    if (normalized.includes("low")) return "low";
    if (normalized === "primary" || normalized === "top") return "high";
    if (normalized === "secondary" || normalized === "diversify") return "low";
    return null;
}

function pickNumber(value: any, fallback: number): number {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function buildAllocationMap(
    targets: SuggestedAllocationTarget[]
): Record<string, number> {
    const map: Record<string, number> = {};
    for (const target of targets) {
        if (!target.vaultAddress) continue;
        map[target.vaultAddress.toLowerCase()] = Number.isFinite(
            Number(target.allocationPct)
        )
            ? Number(target.allocationPct)
            : 0;
    }
    return map;
}

async function delayBetweenRequests(): Promise<void> {
    const ms = Number.isFinite(DATA_DELAY_MS) ? DATA_DELAY_MS : 0;
    if (ms > 0) {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }
}

async function getAlreadyExposedVaults(): Promise<string[]> {
    const wallet = process.env.WALLET as `0x${string}` | undefined;
    if (!wallet) return [];
    try {
        const equities = await HyperliquidConnector.getUserVaultEquities(wallet);
        const unique = new Set<string>();
        for (const entry of equities) {
            if (!entry?.vaultAddress) continue;
            unique.add(String(entry.vaultAddress).toLowerCase());
        }
        return Array.from(unique);
    } catch {
        return [];
    }
}

function chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}
