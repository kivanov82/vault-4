import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";
import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import { MarketDataService } from "./MarketDataService";
import {
    buildPortfolioContext,
    type PortfolioContext,
} from "./portfolioContext";
import type {
    SuggestedAllocations,
    SuggestedAllocationTarget,
    VaultCandidate,
} from "../vaults/types";
import { VaultFeatureService } from "./VaultFeatureService";
import type {
    VaultRawData,
    VaultTradeRow,
    VaultQuantFeatures,
    VaultQuantScore,
    RegimeFlags,
} from "./featureTypes";

type ClaudeRankedVault = {
    vaultAddress: string;
    reason?: string;
    score?: number;
};

export type ClaudeRanking = {
    model: string;
    highConfidence: ClaudeRankedVault[];
    lowConfidence: ClaudeRankedVault[];
    raw: string;
    suggestedAllocations?: SuggestedAllocations;
    allocationMap?: Record<string, number>;
    /** Every stage-1 scored candidate (superset of the ranked set). Consumed
     * by the orchestrator's rotation hurdle — see ExitPolicy.clearsRotationHurdle. */
    stage1Scores?: Array<{ address: string; name: string; score: number }>;
};

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null || raw === "") return fallback;
    const num = Number(raw);
    return Number.isFinite(num) ? num : fallback;
}

const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";
// NOTE: temperature is rejected with a 400 on Sonnet 5 / Opus 4.7+ — remove if CLAUDE_MODEL is ever bumped
const DEFAULT_TEMPERATURE = 0.2;
// Output (completion) cap. 8192 gives the bounded ranking/scoring tool calls
// room to reason per vault without truncation; sonnet-4-6 allows up to 64K, but
// these non-streaming calls should stay under ~16K to avoid SDK HTTP timeouts.
// Now honors the CLAUDE_*_MAX_TOKENS env vars documented in CLAUDE.md.
const SCORING_MAX_TOKENS = envNumber("CLAUDE_SCORING_MAX_TOKENS", 8192);
const RANKING_MAX_TOKENS = envNumber("CLAUDE_RANKING_MAX_TOKENS", 8192);
const BATCH_SIZE = envNumber("CLAUDE_BATCH_SIZE", 5);
const CLAUDE_API_DELAY_MS = envNumber("CLAUDE_API_DELAY_MS", 60000);
// Module scope: consumed by the stage-1 → stage-2 selection slice.
const FINAL_RANKING_LIMIT = envNumber("CLAUDE_FINAL_RANKING_LIMIT", 12);
// Default rises 50 → 250 deliberately: trades no longer reach Claude (token cost
// gone), they only feed local feature computation, and 30-day stats want more
// than 50 fills.
const MAX_TRADES = envNumber("CLAUDE_MAX_TRADES_PER_VAULT", 250);
const MAX_POSITIONS = envNumber("CLAUDE_MAX_POSITIONS_PER_VAULT", 30);
const MAX_PNL_POINTS = envNumber("CLAUDE_MAX_PNL_POINTS", 60);

const PROMPT_PATH = path.join(__dirname, "prompts", "vault-ranking.md");
const SCORING_PROMPT_PATH = path.join(__dirname, "prompts", "vault-scoring.md");
const SHARED_PROMPT_PATH = path.join(__dirname, "prompts", "_shared.md");
const DATA_DELAY_MS = 200;

const SCORING_TOOL = {
    name: "submit_vault_scores",
    description:
        "Submit a bounded qualitative adjustment for every vault in this batch. Do not skip any vault.",
    strict: true,
    input_schema: {
        type: "object" as const,
        additionalProperties: false,
        required: ["scores"],
        properties: {
            scores: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["address", "adjustment", "reason"],
                    properties: {
                        address: {
                            type: "string",
                            description: "Vault address (0x…), exactly as given",
                        },
                        adjustment: {
                            type: "number",
                            description:
                                "Points added to quant_score, between -15 and +15. 0 = no qualitative evidence beyond the computed score.",
                        },
                        reason: {
                            type: "string",
                            description:
                                "One sentence, <= 200 chars. Required even when adjustment is 0.",
                        },
                    },
                },
            },
        },
    },
} as const;

const RANKING_TOOL = {
    name: "submit_vault_ranking",
    description: "Submit the final ranked selection and barbell allocations.",
    strict: true,
    input_schema: {
        type: "object" as const,
        additionalProperties: false,
        required: ["regime", "ranked", "suggested_allocations"],
        properties: {
            regime: {
                type: "object",
                additionalProperties: false,
                required: ["label", "notes"],
                properties: {
                    label: {
                        type: "string",
                        description: "risk-on | neutral | risk-off",
                    },
                    notes: { type: "string", description: "1 sentence" },
                },
            },
            ranked: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["rank", "address", "why_now"],
                    properties: {
                        rank: { type: "number" },
                        address: { type: "string" },
                        why_now: {
                            type: "string",
                            description: "Brief reason, <= 200 chars",
                        },
                    },
                },
            },
            suggested_allocations: {
                type: "object",
                additionalProperties: false,
                required: ["high_pct", "low_pct", "targets"],
                properties: {
                    high_pct: { type: "number" },
                    low_pct: { type: "number" },
                    targets: {
                        type: "array",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            required: [
                                "rank",
                                "vaultAddress",
                                "confidence",
                                "allocation_pct",
                            ],
                            properties: {
                                rank: { type: "number" },
                                vaultAddress: { type: "string" },
                                confidence: {
                                    type: "string",
                                    description: "high | low",
                                },
                                allocation_pct: { type: "number" },
                            },
                        },
                    },
                },
            },
        },
    },
} as const;

type ScoredVault = {
    vaultAddress: string;
    name: string;
    score: number;
    reason?: string;
    candidate: VaultCandidate;
    quantScore: number;
    adjustment: number;
};

// Universe lookups computed once per round and shared across both stages.
type UniverseLookups = {
    regime: RegimeFlags;
    featuresByAddress: Map<string, VaultQuantFeatures>;
    scoringByAddress: Map<string, VaultQuantScore>;
    rankingByAddress: Map<string, VaultQuantScore>;
    rawByAddress: Map<string, VaultRawData>;
};

export class ClaudeService {
    private static client: Anthropic | null = null;
    private static promptCache: string | null = null;
    private static scoringPromptCache: string | null = null;

    static isConfigured(): boolean {
        return Boolean(process.env.ANTHROPIC_API_KEY);
    }

    static async rankVaults(
        candidates: VaultCandidate[],
        totalCount: number,
        highConfidenceCount: number
    ): Promise<ClaudeRanking | null> {
        if (!this.isConfigured()) {
            logger.warn("Anthropic API key missing, skipping AI ranking");
            return null;
        }
        if (!candidates.length) return null;

        const marketData = await MarketDataService.getMarketOverlay();
        // Per-position ROE, our per-vault realized history, and the loss
        // re-entry cooldown list — so selection stops flying blind to our own
        // book (STRATEGY-FORENSICS-2026-06.md action #4).
        const portfolioContext = await buildPortfolioContext();
        const alreadyExposed = portfolioContext.alreadyExposed;

        logger.info("AI ranking context", {
            totalCandidates: candidates.length,
            totalCount,
            highConfidenceCount,
            alreadyExposedCount: alreadyExposed.length,
            alreadyExposed,
            currentPositions: portfolioContext.currentPositions,
            vaultHistoryCount: portfolioContext.vaultHistory.length,
            recentLossExits: portfolioContext.recentLossExits,
            marketDirection: marketData.preferred_direction,
            marketTrend: marketData.trend,
            btc24h: marketData.btc_24h_change,
            btc7d: marketData.btc_7d_change,
            fearGreed: marketData.fearGreed,
            longShortRatio: marketData.long_short_ratio,
        });

        // Fetch all vault data ONCE, then compute the entire universe (features +
        // universe-wide robust z + stage-specific quant scores) deterministically.
        // This replaces the old per-batch fetch inside scoreVaultBatch and the
        // stage-2 refetch inside finalRanking (also saving HL rate budget).
        const rawData = await fetchVaultRawData(candidates, {
            maxTrades: MAX_TRADES,
            maxPositions: MAX_POSITIONS,
        });
        const universe = VaultFeatureService.computeUniverse(
            rawData,
            marketData,
            Date.now()
        );

        const featuresByAddress = new Map<string, VaultQuantFeatures>();
        for (const f of universe.features) {
            featuresByAddress.set(f.address.toLowerCase(), f);
        }
        const scoringByAddress = new Map<string, VaultQuantScore>();
        for (const s of universe.scoring) {
            scoringByAddress.set(s.address.toLowerCase(), s);
        }
        const rankingByAddress = new Map<string, VaultQuantScore>();
        for (const s of universe.ranking) {
            rankingByAddress.set(s.address.toLowerCase(), s);
        }
        const rawByAddress = new Map<string, VaultRawData>();
        for (const r of rawData) {
            rawByAddress.set(r.candidate.vaultAddress.toLowerCase(), r);
        }
        const lookups: UniverseLookups = {
            regime: universe.regime,
            featuresByAddress,
            scoringByAddress,
            rankingByAddress,
            rawByAddress,
        };

        const scoringSorted = [...universe.scoring].sort((a, b) => b.score - a.score);
        logger.info("Universe features computed", {
            vaultCount: universe.features.length,
            regime: universe.regime,
            scoringTop5: scoringSorted
                .slice(0, 5)
                .map((s) => ({ name: s.name, score: s.score })),
            scoringBottom5: scoringSorted
                .slice(-5)
                .map((s) => ({ name: s.name, score: s.score })),
        });

        // Stage 1: Score vaults in batches
        const batches = chunkArray(candidates, BATCH_SIZE);
        logger.info("Starting batched vault scoring", {
            totalCandidates: candidates.length,
            batchSize: BATCH_SIZE,
            batchCount: batches.length,
        });

        // Process batches sequentially with delay to respect rate limits
        const batchResults: ScoredVault[][] = [];
        for (let i = 0; i < batches.length; i++) {
            if (i > 0 && CLAUDE_API_DELAY_MS > 0) {
                logger.info("Waiting between batches to respect rate limits", {
                    delayMs: CLAUDE_API_DELAY_MS,
                    batchIndex: i,
                });
                await new Promise((resolve) => setTimeout(resolve, CLAUDE_API_DELAY_MS));
            }
            const result = await this.scoreVaultBatch(
                batches[i],
                marketData,
                portfolioContext,
                i,
                lookups
            );
            batchResults.push(result);
        }

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
            scoreDistribution: {
                above80: allScored.filter((s) => s.score >= 80).length,
                above60: allScored.filter((s) => s.score >= 60).length,
                above40: allScored.filter((s) => s.score >= 40).length,
                below40: allScored.filter((s) => s.score < 40).length,
            },
            allScores: allScored.map((s) => ({
                name: s.name,
                quantScore: s.quantScore,
                adjustment: s.adjustment,
                score: s.score,
                address: s.vaultAddress,
            })),
        });

        // Stage 2: Final ranking of top candidates
        const topCandidates = allScored.slice(0, FINAL_RANKING_LIMIT);

        logger.info("Stage 2 candidates selected", {
            finalRankingLimit: FINAL_RANKING_LIMIT,
            selectedCount: topCandidates.length,
            selectedVaults: topCandidates.map((s) => ({
                name: s.name,
                score: s.score,
                isExposed: alreadyExposed.includes(s.vaultAddress),
            })),
        });

        // Wait before Stage 2 to respect rate limits
        if (CLAUDE_API_DELAY_MS > 0) {
            logger.info("Waiting before final ranking to respect rate limits", {
                delayMs: CLAUDE_API_DELAY_MS,
            });
            await new Promise((resolve) => setTimeout(resolve, CLAUDE_API_DELAY_MS));
        }

        const ranking = await this.finalRanking(
            topCandidates,
            marketData,
            portfolioContext,
            totalCount,
            highConfidenceCount,
            lookups
        );
        if (ranking) {
            // Ride the full stage-1 score list on the ranking so the rotation
            // hurdle always compares scores from the same run that produced
            // the recommendation set.
            ranking.stage1Scores = allScored.map((s) => ({
                address: s.vaultAddress.toLowerCase(),
                name: s.name,
                score: s.score,
            }));
        }
        return ranking;
    }

    static async scoreVaultBatch(
        batch: VaultCandidate[],
        marketData: any,
        portfolioContext: PortfolioContext,
        batchIndex: number,
        lookups: UniverseLookups
    ): Promise<ScoredVault[]> {
        const client = this.getClient();
        const systemPrompt = this.getScoringPromptTemplate();
        const alreadyExposed = portfolioContext.alreadyExposed;
        const { regime, featuresByAddress, scoringByAddress, rawByAddress } = lookups;

        const vaultsPayload = batch
            .map((candidate) => {
                const addr = candidate.vaultAddress.toLowerCase();
                const f = featuresByAddress.get(addr);
                const raw = rawByAddress.get(addr);
                const quant = scoringByAddress.get(addr);
                if (!f || !raw || !quant) return null;
                return buildPromptVault(f, quant, raw);
            })
            .filter((v) => v !== null);

        const userPrompt = `market_data = ${JSON.stringify(marketData)}

regime_flags = ${JSON.stringify(regime)}

already_exposed = ${JSON.stringify(alreadyExposed)}

current_positions = ${JSON.stringify(portfolioContext.currentPositions)}

our_vault_history = ${JSON.stringify(portfolioContext.vaultHistory)}

recently_exited_at_loss = ${JSON.stringify(portfolioContext.recentLossExits)}

vaults = ${JSON.stringify(vaultsPayload)}`;

        try {
            logger.info("Scoring batch", {
                batchIndex,
                vaultCount: batch.length,
            });

            const response = await client.messages.create({
                model: MODEL,
                max_tokens: SCORING_MAX_TOKENS,
                temperature: DEFAULT_TEMPERATURE,
                // Prompt caching (stage 1 only — stage 2 runs once per round). The
                // system prompt is identical across the 6–10 batches that run 60s
                // apart (< the 5-min TTL), so batches 2..N read the cache. NOTE:
                // sonnet-4-6's minimum cacheable prefix is 2048 tokens — if the
                // system prompt sits under it, reads stay 0 and that is harmless.
                system: [
                    {
                        type: "text" as const,
                        text: systemPrompt,
                        cache_control: { type: "ephemeral" as const },
                    },
                ],
                tools: [SCORING_TOOL as any],
                tool_choice: { type: "tool", name: SCORING_TOOL.name },
                messages: [{ role: "user", content: userPrompt }],
            });

            const toolUse = response.content.find(
                (b: any) => b.type === "tool_use" && b.name === SCORING_TOOL.name
            ) as any;
            const parsed = toolUse?.input ?? null;
            const content = parsed ? JSON.stringify(parsed) : "";

            if (!parsed || !Array.isArray(parsed.scores)) {
                logger.warn("Batch scoring response invalid", {
                    batchIndex,
                    responsePreview: content.slice(0, 500),
                    responseLength: content.length,
                    model: MODEL,
                    parsedType: typeof parsed,
                    hasScoresArray: parsed ? Array.isArray(parsed.scores) : false,
                });
                return [];
            }

            const scored: ScoredVault[] = [];
            const seen = new Set<string>();
            for (const entry of parsed.scores) {
                const address = String(entry.address ?? "").toLowerCase();
                const candidate = batch.find(
                    (c) => c.vaultAddress.toLowerCase() === address
                );
                if (!candidate) {
                    logger.warn("Scored address not in this batch, skipping", {
                        address,
                        batchIndex,
                    });
                    continue;
                }
                // First entry wins on duplicate addresses.
                if (seen.has(address)) continue;

                const quant = scoringByAddress.get(address);
                const quantScore = quant ? quant.score : 0;
                const adj = clampNum(Number(entry.adjustment) || 0, -15, 15);
                const finalScore = clampNum(round1(quantScore + adj), 0, 100);
                seen.add(address);
                scored.push({
                    vaultAddress: address,
                    name: candidate.name,
                    score: finalScore,
                    reason: entry.reason,
                    candidate,
                    quantScore,
                    adjustment: adj,
                });
            }

            // Vault in batch but missing from the response: adjustment 0, final =
            // quant score (the quant score is always available, so the old
            // default-25 punishment is gone).
            for (const candidate of batch) {
                const addr = candidate.vaultAddress.toLowerCase();
                if (seen.has(addr)) continue;
                const quant = scoringByAddress.get(addr);
                const quantScore = quant ? quant.score : 0;
                logger.warn("Vault missing from batch scores, using quant score", {
                    name: candidate.name,
                    batchIndex,
                    quantScore,
                });
                seen.add(addr);
                scored.push({
                    vaultAddress: addr,
                    name: candidate.name,
                    score: clampNum(round1(quantScore), 0, 100),
                    reason: "no model adjustment",
                    candidate,
                    quantScore,
                    adjustment: 0,
                });
            }

            logger.info("Batch scored", {
                batchIndex,
                scoredCount: scored.length,
                cacheReadTokens: (response.usage as any)?.cache_read_input_tokens,
                cacheCreationTokens: (response.usage as any)
                    ?.cache_creation_input_tokens,
                scores: scored.map((s) => ({
                    name: s.name,
                    quantScore: s.quantScore,
                    adjustment: s.adjustment,
                    score: s.score,
                })),
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
        topCandidates: ScoredVault[],
        marketData: any,
        portfolioContext: PortfolioContext,
        totalCount: number,
        highConfidenceCount: number,
        lookups: UniverseLookups
    ): Promise<ClaudeRanking | null> {
        const client = this.getClient();
        const systemPrompt = this.getPromptTemplate();
        const { regime, featuresByAddress, rankingByAddress, rawByAddress } = lookups;

        const candidateAddresses = new Set(
            topCandidates.map((s) => s.vaultAddress.toLowerCase())
        );

        const vaultsPayload = topCandidates
            .map((s) => {
                const addr = s.vaultAddress.toLowerCase();
                const f = featuresByAddress.get(addr);
                const raw = rawByAddress.get(addr);
                const quant = rankingByAddress.get(addr);
                if (!f || !raw || !quant) return null;
                return buildPromptVault(f, quant, raw);
            })
            .filter((v) => v !== null);

        const portfolioShape = {
            max_active: totalCount,
            high_slots: highConfidenceCount,
            low_slots: totalCount - highConfidenceCount,
        };
        const stage1Results = topCandidates.map((s) => ({
            address: s.vaultAddress,
            name: s.name,
            quant_score: s.quantScore,
            adjustment: s.adjustment,
            final_score: s.score,
            reason: s.reason ?? null,
        }));

        const userPrompt = `market_data = ${JSON.stringify(marketData)}

regime_flags = ${JSON.stringify(regime)}

already_exposed = ${JSON.stringify(portfolioContext.alreadyExposed)}

current_positions = ${JSON.stringify(portfolioContext.currentPositions)}

our_vault_history = ${JSON.stringify(portfolioContext.vaultHistory)}

recently_exited_at_loss = ${JSON.stringify(portfolioContext.recentLossExits)}

vaults = ${JSON.stringify(vaultsPayload)}

portfolio_shape = ${JSON.stringify(portfolioShape)}

stage1_results = ${JSON.stringify(stage1Results)}`;

        try {
            logger.info("Stage 2: Final ranking", {
                candidateCount: topCandidates.length,
                model: MODEL,
            });

            const response = await client.messages.create({
                model: MODEL,
                max_tokens: RANKING_MAX_TOKENS,
                temperature: DEFAULT_TEMPERATURE,
                system: systemPrompt,
                tools: [RANKING_TOOL as any],
                tool_choice: { type: "tool", name: RANKING_TOOL.name },
                messages: [{ role: "user", content: userPrompt }],
            });

            const toolUse = response.content.find(
                (b: any) => b.type === "tool_use" && b.name === RANKING_TOOL.name
            ) as any;
            const parsed = toolUse?.input ?? null;
            const content = parsed ? JSON.stringify(parsed) : "";
            if (!parsed) {
                logger.warn("Claude response was not valid JSON", {
                    responsePreview: content.slice(0, 500),
                    responseLength: content.length,
                    model: MODEL,
                });
                return null;
            }
            const rankedRaw = normalizeRankedList(
                parsed.ranked ?? parsed.top10 ?? parsed.top_10
            );
            if (!rankedRaw.length) {
                logger.warn("Claude response missing ranked array");
                return null;
            }
            const suggestedAllocations = parseSuggestedAllocations(
                parsed.suggested_allocations ?? parsed.suggestedAllocations
            );

            if (suggestedAllocations) {
                logger.info("Claude barbell suggestion received", {
                    totalPct: suggestedAllocations.totalPct,
                    highPct: suggestedAllocations.highPct,
                    lowPct: suggestedAllocations.lowPct,
                });
            }

            // The model no longer emits per-entry scores; the stage-1 FINAL score
            // (universe-comparable) is the authoritative value, looked up by address.
            const stage1ByAddress = new Map<string, number>();
            for (const s of topCandidates) {
                stage1ByAddress.set(s.vaultAddress.toLowerCase(), s.score);
            }

            const dropped: string[] = [];
            const ranked = rankedRaw
                .map((entry) => {
                    const address = String(
                        entry.address ?? entry.vaultAddress ?? ""
                    ).toLowerCase();
                    return {
                        vaultAddress: address,
                        reason: entry.why_now,
                        score: stage1ByAddress.has(address)
                            ? stage1ByAddress.get(address)
                            : undefined,
                        rank: entry.rank,
                    };
                })
                .filter((entry) => {
                    if (!entry.vaultAddress) return false;
                    if (!candidateAddresses.has(entry.vaultAddress)) {
                        dropped.push(entry.vaultAddress);
                        return false;
                    }
                    return true;
                });

            if (dropped.length) {
                logger.warn("Dropped ranked addresses not in stage-2 candidate set", {
                    dropped,
                });
            }
            if (!ranked.length) {
                logger.warn("Claude ranking had no valid candidate-set addresses");
                return null;
            }

            const ordered = ranked.some((entry) => Number.isFinite(entry.rank))
                ? ranked
                      .slice()
                      .sort(
                          (a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0)
                      )
                : ranked;

            const high = ordered.slice(0, highConfidenceCount);
            const low = ordered.slice(highConfidenceCount);
            if (!high.length) {
                logger.warn("Claude response returned no high-confidence vaults");
                return null;
            }

            const allocationMap = suggestedAllocations
                ? buildAllocationMap(suggestedAllocations.targets)
                : undefined;

            logger.info("Claude ranking parsed", {
                model: MODEL,
                regime: parsed.regime,
                total: ordered.length,
                highConfidence: high.map((v) => ({
                    address: v.vaultAddress,
                    score: v.score,
                    reason: v.reason,
                })),
                lowConfidence: low.map((v) => ({
                    address: v.vaultAddress,
                    score: v.score,
                    reason: v.reason,
                })),
                suggestedAllocations: {
                    totalPct: suggestedAllocations?.totalPct,
                    highPct: suggestedAllocations?.highPct,
                    lowPct: suggestedAllocations?.lowPct,
                },
            });

            return {
                model: MODEL,
                highConfidence: normalizeRankedVaults(high),
                lowConfidence: normalizeRankedVaults(low),
                raw: content,
                allocationMap,
                suggestedAllocations: suggestedAllocations ?? undefined,
            };
        } catch (error: any) {
            logger.warn("Claude ranking failed", { message: error?.message });
            return null;
        }
    }

    private static getClient(): Anthropic {
        if (!this.client) {
            this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        }
        return this.client;
    }

    /** Concatenate the shared judgment brief with a stage-specific prompt. If
     * `_shared.md` is missing (e.g. pre-WP-B merge), fall back to the stage
     * file alone so the service still boots. */
    private static loadPrompt(stagePath: string): string {
        const stage = fs.readFileSync(stagePath, "utf8");
        try {
            const shared = fs.readFileSync(SHARED_PROMPT_PATH, "utf8");
            return `${shared}\n\n---\n\n${stage}`;
        } catch (error: any) {
            logger.warn("Shared prompt fragment missing, using stage prompt alone", {
                path: SHARED_PROMPT_PATH,
                message: error?.message,
            });
            return stage;
        }
    }

    private static getPromptTemplate(): string {
        if (!this.promptCache) {
            this.promptCache = this.loadPrompt(PROMPT_PATH);
        }
        return this.promptCache;
    }

    private static getScoringPromptTemplate(): string {
        if (!this.scoringPromptCache) {
            this.scoringPromptCache = this.loadPrompt(SCORING_PROMPT_PATH);
        }
        return this.scoringPromptCache;
    }
}

/** Round with null/undefined/non-finite passthrough to null. */
function roundTo(value: number | null | undefined, dp: number): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const factor = Math.pow(10, dp);
    return Math.round(n * factor) / factor;
}

function round1(x: number): number {
    return Math.round(x * 10) / 10;
}

function clampNum(x: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, x));
}

/** Build the Overview §6 Claude-facing per-vault payload (snake_case; `null`
 * passthrough; `_rt`/ratios 4dp, USD 2dp, score 1dp). `quant` supplies both the
 * stage-appropriate score and the regime-alignment classification. */
function buildPromptVault(
    f: VaultQuantFeatures,
    quant: VaultQuantScore,
    raw: VaultRawData
): any {
    const positions = Array.isArray(raw?.assetPositions) ? raw.assetPositions : [];
    const topPositions = positions
        .map((entry: any) => {
            const p = entry?.position;
            if (!p) return null;
            const value = Number(p.positionValue);
            const abs = Number.isFinite(value) ? Math.abs(value) : 0;
            return {
                coin: String(p.coin ?? ""),
                side: Number(p.szi) >= 0 ? "long" : "short",
                value_usd: roundTo(Number.isFinite(value) ? value : 0, 2),
                unrealized_pnl: roundTo(p.unrealizedPnl, 2),
                _abs: abs,
            };
        })
        .filter((p: any) => p !== null)
        .sort((a: any, b: any) => b._abs - a._abs)
        .slice(0, 5)
        .map(({ _abs, ...rest }: any) => rest);

    return {
        address: f.address,
        name: f.name,
        tvl: roundTo(f.tvl, 2),
        quant_score: roundTo(quant.score, 1),
        aligned: quant.aligned,
        direction: f.direction,
        data_quality: f.dataQuality,
        features: {
            day_rt: roundTo(f.dayRt, 4),
            week_rt: roundTo(f.weekRt, 4),
            pnl7_rt: roundTo(f.pnl7Rt, 4),
            pnl30_rt: roundTo(f.pnl30Rt, 4),
            unreal_rt: roundTo(f.unrealRt, 4),
            net_rt: roundTo(f.netRt, 4),
            btc_rt: roundTo(f.btcRt, 4),
            majors_rt: roundTo(f.majorsRt, 4),
            alts_rt: roundTo(f.altsRt, 4),
            gross_lev: roundTo(f.grossLev, 4),
            winrate_7d: roundTo(f.winrate7d, 4),
            winrate_30d: roundTo(f.winrate30d, 4),
            trades_7d: f.trades7d,
            trades_30d: f.trades30d,
            short_ratio_7d: roundTo(f.shortRatio7d, 4),
            short_ratio_30d: roundTo(f.shortRatio30d, 4),
            pnl_sd_7d: roundTo(f.pnlSd7d, 2),
            pnl_sd_30d: roundTo(f.pnlSd30d, 2),
            month_max_dd_rt: roundTo(f.monthMaxDdRt, 4),
            mm_proxy: f.mmProxy,
        },
        top_positions: topPositions,
    };
}

function normalizeRankedList(entries: any): any[] {
    return Array.isArray(entries) ? entries : [];
}

function normalizeRankedVaults(entries: any[]): ClaudeRankedVault[] {
    return entries
        .map((entry) => ({
            vaultAddress: String(entry.vaultAddress ?? "").trim(),
            reason: entry.reason ? String(entry.reason).trim() : undefined,
            score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : undefined,
        }))
        .filter((entry) => Boolean(entry.vaultAddress));
}

async function fetchVaultRawData(
    candidates: VaultCandidate[],
    options: { maxTrades: number; maxPositions: number }
): Promise<VaultRawData[]> {
    const rawData: VaultRawData[] = [];
    for (const candidate of candidates) {
        const vaultAddress = candidate.vaultAddress;
        const trades: VaultTradeRow[] = await HyperliquidConnector.getVaultTrades(
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
        rawData.push({
            candidate,
            trades,
            assetPositions: positions,
            pnls: pnlSeries as PnlSeries[],
        });
    }
    return rawData;
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
    return {
        totalPct,
        highPct,
        lowPct,
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

function chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}
