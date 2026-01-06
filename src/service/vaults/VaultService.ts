import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import { OpenAIService } from "../openai/OpenAIService";
import { logger } from "../utils/logger";
import type {
    CandidatesResult,
    RecommendationSet,
    VaultCandidate,
    VaultFilters,
    VaultHistory,
    VaultMetrics,
    VaultRecommendation,
    UserPortfolioSummary,
    UserVaultHistory,
    UserVaultsResponse,
} from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const RESERVED_NAMES = new Set(
    (process.env.VAULT_RESERVED_NAMES ??
        "HLP Strategy A,HLP Liquidator,HLP Strategy B,HLP Liquidator 2")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
);

const DEFAULT_FILTERS: VaultFilters = {
    minTvl: readNumberEnv(process.env.VAULT_MIN_TVL, 10000),
    minAgeDays: readNumberEnv(process.env.VAULT_MIN_AGE_DAYS, 21),
    minFollowers: readNumberEnv(process.env.VAULT_MIN_FOLLOWERS, 10),
    minTrades7d: readNumberEnv(process.env.VAULT_MIN_TRADES_7D, 10),
    requirePositiveWeeklyPnl:
        (process.env.VAULT_REQUIRE_POSITIVE_WEEKLY_PNL ?? "true") === "true",
    requirePositiveMonthlyPnl:
        (process.env.VAULT_REQUIRE_POSITIVE_MONTHLY_PNL ?? "true") === "true",
    requireDepositsOpen:
        (process.env.VAULT_REQUIRE_DEPOSITS_OPEN ?? "true") === "true",
};

const CANDIDATE_CACHE_TTL_MS = readNumberEnv(
    process.env.VAULT_CACHE_TTL_MS,
    5 * 60 * 1000
);
const RECOMMENDATION_CACHE_TTL_MS = readNumberEnv(
    process.env.VAULT_RECOMMENDATION_TTL_MS,
    15 * 60 * 1000
);
const RECOMMENDATION_COUNT = readNumberEnv(
    process.env.VAULT_RECOMMENDATION_COUNT,
    10
);
const HIGH_CONF_COUNT = readNumberEnv(process.env.VAULT_HIGH_CONF_COUNT, 5);
const HIGH_ALLOC_PCT = readNumberEnv(process.env.VAULT_ALLOC_HIGH_PCT, 70);
const LOW_ALLOC_PCT = readNumberEnv(process.env.VAULT_ALLOC_LOW_PCT, 30);
const USER_VAULTS_CACHE_TTL_MS = readNumberEnv(
    process.env.USER_VAULTS_CACHE_TTL_MS,
    5 * 60 * 1000
);
const USER_VAULTS_CONCURRENCY = Math.max(
    1,
    readNumberEnv(process.env.USER_VAULTS_CONCURRENCY, 3)
);
const USER_PORTFOLIO_CACHE_TTL_MS = readNumberEnv(
    process.env.USER_PORTFOLIO_CACHE_TTL_MS,
    2 * 60 * 1000
);

type CandidateOptions = {
    refresh?: boolean;
    filters?: Partial<VaultFilters>;
};

type RecommendationOptions = {
    refresh?: boolean;
    refreshCandidates?: boolean;
};

type Cached<T> = { fetchedAt: number; result: T };

export class VaultService {
    private static candidatesCache: Cached<CandidatesResult> | null = null;
    private static recommendationsCache: Cached<RecommendationSet> | null = null;
    private static recommendationsHistory: RecommendationSet[] = [];
    private static userVaultsCache: Map<string, Cached<UserVaultsResponse>> =
        new Map();
    private static userPortfolioCache: Map<
        string,
        Cached<UserPortfolioSummary | null>
    > = new Map();

    static async warm(): Promise<void> {
        try {
            if (process.env.VAULT_WARM_RECOMMENDATIONS === "true") {
                await this.getRecommendations({ refresh: true, refreshCandidates: true });
            }
        } catch (error: any) {
            logger.warn("Warmup failed", { message: error?.message });
        }
    }

    static async getCandidates(options: CandidateOptions = {}): Promise<CandidatesResult> {
        logger.info("Searching for vault candidates");
        const filters = mergeFilters(options.filters);
        const now = Date.now();
        if (
            !options.refresh &&
            this.candidatesCache &&
            now - this.candidatesCache.fetchedAt < CANDIDATE_CACHE_TTL_MS &&
            sameFilters(this.candidatesCache.result.filters, filters)
        ) {
            return this.candidatesCache.result;
        }

        const rawVaults = await HyperliquidConnector.getVaults();
        const candidates: VaultCandidate[] = [];

        for (const vault of rawVaults) {
            const summary = vault.summary;
            if (!summary || summary.isClosed) continue;
            if (RESERVED_NAMES.has(summary.name)) continue;

            const tvl = toNumber(summary.tvl, 0);
            const ageDays = ageInDays(summary.createTimeMillis);
            const performance = HyperliquidConnector.parsePerformance(vault);

            if (tvl < filters.minTvl) continue;
            if (ageDays < filters.minAgeDays) continue;
            if (
                filters.requirePositiveWeeklyPnl &&
                !(performance.weeklyPnl !== null && performance.weeklyPnl > 0)
            )
                continue;
            if (
                filters.requirePositiveMonthlyPnl &&
                !(performance.monthlyPnl !== null && performance.monthlyPnl > 0)
            )
                continue;

            const details = await HyperliquidConnector.getVaultDetails(
                summary.vaultAddress
            );
            const followers =
                Array.isArray(details?.followers) ? details?.followers.length : null;
            const allowDeposits =
                typeof details?.allowDeposits === "boolean"
                    ? details.allowDeposits
                    : null;
            const tradesLast7d = await HyperliquidConnector.getVaultTradesCount(
                summary.vaultAddress,
                7
            );

            if (filters.requireDepositsOpen && allowDeposits === false) continue;
            if (
                filters.minFollowers > 0 &&
                typeof followers === "number" &&
                followers < filters.minFollowers
            )
                continue;
            if (
                filters.minTrades7d > 0 &&
                typeof tradesLast7d === "number" &&
                tradesLast7d < filters.minTrades7d
            )
                continue;

            logger.info("Found vault candidate", {name: summary.name});
            candidates.push({
                vaultAddress: summary.vaultAddress,
                name: summary.name,
                tvl,
                ageDays,
                isClosed: summary.isClosed,
                weeklyPnl: performance.weeklyPnl,
                monthlyPnl: performance.monthlyPnl,
                allTimePnl: performance.allTimePnl,
                followers,
                allowDeposits,
                tradesLast7d,
                performance,
                raw: vault,
            });
        }

        candidates.sort((a, b) => b.tvl - a.tvl);

        const result: CandidatesResult = {
            generatedAt: new Date().toISOString(),
            filters,
            count: candidates.length,
            items: candidates,
        };
        this.candidatesCache = { fetchedAt: now, result };
        logger.info("Found vault candidates", { count: candidates.length });
        return result;
    }

    static async getVaultSnapshot(vaultAddress: string): Promise<VaultCandidate | null> {
        const rawVaults = await HyperliquidConnector.getVaults();
        const match = rawVaults.find(
            (vault) =>
                vault?.summary?.vaultAddress?.toLowerCase() ===
                vaultAddress.toLowerCase()
        );
        if (!match) return null;

        const summary = match.summary;
        const performance = HyperliquidConnector.parsePerformance(match);
        const details = await HyperliquidConnector.getVaultDetails(summary.vaultAddress);
        const followers =
            Array.isArray(details?.followers) ? details?.followers.length : null;
        const allowDeposits =
            typeof details?.allowDeposits === "boolean" ? details.allowDeposits : null;
        const tradesLast7d = await HyperliquidConnector.getVaultTradesCount(
            summary.vaultAddress,
            7
        );

        return {
            vaultAddress: summary.vaultAddress,
            name: summary.name,
            tvl: toNumber(summary.tvl, 0),
            ageDays: ageInDays(summary.createTimeMillis),
            isClosed: summary.isClosed,
            weeklyPnl: performance.weeklyPnl,
            monthlyPnl: performance.monthlyPnl,
            allTimePnl: performance.allTimePnl,
            followers,
            allowDeposits,
            tradesLast7d,
            performance,
            raw: match,
        };
    }

    static async getRecommendations(
        options: RecommendationOptions = {}
    ): Promise<RecommendationSet> {
        logger.info("Generating vault recommendations");
        const now = Date.now();
        if (
            !options.refresh &&
            this.recommendationsCache &&
            now - this.recommendationsCache.fetchedAt < RECOMMENDATION_CACHE_TTL_MS
        ) {
            return this.recommendationsCache.result;
        }

        const candidatesResult = await this.getCandidates({
            refresh: options.refreshCandidates,
        });
        const candidates = candidatesResult.items;
        const totalCount = Math.min(RECOMMENDATION_COUNT, candidates.length);
        const highCount = Math.min(HIGH_CONF_COUNT, totalCount);

        let source: "openai" | "heuristic" = "heuristic";
        let model: string | undefined;
        let highConfidence: VaultRecommendation[] = [];
        let lowConfidence: VaultRecommendation[] = [];

        if (totalCount > 0) {
            logger.info("Ranking vault candidates with OpenAI");
            const aiRanking = await OpenAIService.rankVaults(
                candidates,
                totalCount,
                highCount
            );
            if (aiRanking) {
                const mapped = mapOpenAiRanking(
                    aiRanking.highConfidence,
                    aiRanking.lowConfidence,
                    candidates,
                    highCount,
                    totalCount
                );
                if (mapped) {
                    source = "openai";
                    model = aiRanking.model;
                    highConfidence = mapped.highConfidence;
                    lowConfidence = mapped.lowConfidence;
                }
            }

            if (!highConfidence.length && !lowConfidence.length) {
                const ranked = rankByHeuristic(candidates, totalCount, highCount);
                highConfidence = ranked.highConfidence;
                lowConfidence = ranked.lowConfidence;
            }
        }

        const allocations = allocateGroups(
            highConfidence,
            lowConfidence,
            HIGH_ALLOC_PCT,
            LOW_ALLOC_PCT
        );

        const result: RecommendationSet = {
            generatedAt: new Date().toISOString(),
            source,
            model,
            highConfidence: allocations.highConfidence,
            lowConfidence: allocations.lowConfidence,
            candidates: {
                count: candidates.length,
                generatedAt: candidatesResult.generatedAt,
            },
        };

        if (this.recommendationsCache?.result) {
            this.recommendationsHistory.unshift(this.recommendationsCache.result);
            this.recommendationsHistory = this.recommendationsHistory.slice(0, 20);
        }
        this.recommendationsCache = { fetchedAt: now, result };
        logger.info("Generated vault recommendations", {
            source,
            model,
            total: result.highConfidence.length + result.lowConfidence.length,
        });
        return result;
    }

    static async getVaultMetrics(vaultAddress: string): Promise<VaultMetrics | null> {
        return HyperliquidConnector.getVaultMetrics(vaultAddress);
    }

    static async getVaultHistory(vaultAddress: string): Promise<VaultHistory | null> {
        return HyperliquidConnector.getVaultHistory(vaultAddress);
    }

    static async getUserVaults(
        userAddress: string,
        options: { refresh?: boolean; includeHistory?: boolean } = {}
    ): Promise<UserVaultsResponse> {
        const key = `${userAddress.toLowerCase()}:${
            options.includeHistory ? "with-history" : "base"
        }`;
        const now = Date.now();
        const cached = this.userVaultsCache.get(key);
        if (
            cached &&
            !options.refresh &&
            now - cached.fetchedAt < USER_VAULTS_CACHE_TTL_MS
        ) {
            return cached.result;
        }
        const equities = await HyperliquidConnector.getUserVaultEquities(
            userAddress as `0x${string}`
        );
        const items = await mapWithConcurrency(
            equities,
            USER_VAULTS_CONCURRENCY,
            async (equity) => {
            const details = await HyperliquidConnector.getVaultDetails(
                equity.vaultAddress
            );
            const vaultMetrics = details
                ? HyperliquidConnector.getVaultMetricsFromDetails(
                      details,
                      equity.vaultAddress
                  )
                : await HyperliquidConnector.getVaultMetrics(equity.vaultAddress);
            const userPerformance = details
                ? HyperliquidConnector.getUserVaultPerformance(details, userAddress)
                : null;
            const userHistory = options.includeHistory
                ? details
                    ? HyperliquidConnector.getUserVaultHistoryFromDetails(
                          details,
                          userAddress as `0x${string}`
                      )
                    : await HyperliquidConnector.getUserVaultHistory(
                          userAddress as `0x${string}`,
                          equity.vaultAddress as `0x${string}`
                      )
                : undefined;
            return {
                vaultAddress: equity.vaultAddress,
                equity: equity.equity,
                lockedUntilTimestamp: equity.lockedUntilTimestamp,
                vaultName: details?.name ?? vaultMetrics?.name ?? undefined,
                vaultMetrics,
                userPerformance,
                userHistory,
            };
        }
        );
        const result = {
            userAddress,
            count: items.length,
            items,
        };
        this.userVaultsCache.set(key, { fetchedAt: now, result });
        return result;
    }

    static async getUserPortfolio(
        userAddress: string,
        options: { refresh?: boolean } = {}
    ): Promise<UserPortfolioSummary | null> {
        const key = userAddress.toLowerCase();
        const now = Date.now();
        const cached = this.userPortfolioCache.get(key);
        if (
            cached &&
            !options.refresh &&
            now - cached.fetchedAt < USER_PORTFOLIO_CACHE_TTL_MS
        ) {
            return cached.result;
        }
        const result = await HyperliquidConnector.getUserPortfolioSummary(
            userAddress as `0x${string}`
        );
        this.userPortfolioCache.set(key, { fetchedAt: now, result });
        return result;
    }

    static async getUserVaultHistory(
        userAddress: string,
        vaultAddress: string
    ): Promise<UserVaultHistory | null> {
        return HyperliquidConnector.getUserVaultHistory(
            userAddress as `0x${string}`,
            vaultAddress as `0x${string}`
        );
    }
}

function ageInDays(createTimeMillis: number): number {
    if (!Number.isFinite(Number(createTimeMillis))) return 0;
    const delta = Date.now() - Number(createTimeMillis);
    return Math.max(0, delta / MS_PER_DAY);
}

function readNumberEnv(value: any, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toNumber(value: any, fallback: number): number {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function sameFilters(a: VaultFilters, b: VaultFilters): boolean {
    return (
        a.minTvl === b.minTvl &&
        a.minAgeDays === b.minAgeDays &&
        a.minFollowers === b.minFollowers &&
        a.minTrades7d === b.minTrades7d &&
        a.requirePositiveWeeklyPnl === b.requirePositiveWeeklyPnl &&
        a.requirePositiveMonthlyPnl === b.requirePositiveMonthlyPnl &&
        a.requireDepositsOpen === b.requireDepositsOpen
    );
}

function mergeFilters(overrides?: Partial<VaultFilters>): VaultFilters {
    const merged: VaultFilters = { ...DEFAULT_FILTERS };
    if (!overrides) return merged;
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined || value === null) continue;
        (merged as any)[key] = value;
    }
    return merged;
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

function rankByHeuristic(
    candidates: VaultCandidate[],
    totalCount: number,
    highCount: number
): { highConfidence: VaultRecommendation[]; lowConfidence: VaultRecommendation[] } {
    const scored = candidates
        .map((candidate) => ({
            candidate,
            score: scoreCandidate(candidate),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, totalCount);

    const high = scored.slice(0, highCount).map((entry) =>
        buildRecommendation(entry.candidate, "high", entry.score)
    );
    const low = scored.slice(highCount).map((entry) =>
        buildRecommendation(entry.candidate, "low", entry.score)
    );
    return { highConfidence: high, lowConfidence: low };
}

function scoreCandidate(candidate: VaultCandidate): number {
    const weeklyPct = safeRatio(candidate.weeklyPnl, candidate.tvl);
    const monthlyPct = safeRatio(candidate.monthlyPnl, candidate.tvl);
    const allTimePct = safeRatio(candidate.allTimePnl, candidate.tvl);
    const tvlScore = Math.log10(candidate.tvl + 1);
    const followersScore =
        candidate.followers && candidate.followers > 0
            ? Math.log10(candidate.followers + 1)
            : 0;
    const tradesScore =
        candidate.tradesLast7d && candidate.tradesLast7d > 0
            ? Math.log10(candidate.tradesLast7d + 1)
            : 0;
    const ageScore = Math.min(candidate.ageDays / 30, 12);

    return (
        weeklyPct * 400 +
        monthlyPct * 200 +
        allTimePct * 100 +
        tvlScore * 10 +
        followersScore * 2 +
        tradesScore +
        ageScore
    );
}

function safeRatio(value: number | null, denom: number): number {
    if (value === null) return 0;
    if (!Number.isFinite(value) || !Number.isFinite(denom) || denom === 0) return 0;
    return value / denom;
}

function buildRecommendation(
    candidate: VaultCandidate,
    confidence: "high" | "low",
    score?: number,
    reason?: string
): VaultRecommendation {
    return {
        vaultAddress: candidate.vaultAddress,
        name: candidate.name,
        confidence,
        allocationPct: 0,
        reason,
        score,
        metrics: {
            tvl: candidate.tvl,
            weeklyPnl: candidate.weeklyPnl,
            monthlyPnl: candidate.monthlyPnl,
            allTimePnl: candidate.allTimePnl,
            ageDays: candidate.ageDays,
            followers: candidate.followers,
            tradesLast7d: candidate.tradesLast7d,
        },
    };
}

function mapOpenAiRanking(
    high: { vaultAddress: string; reason?: string; score?: number }[],
    low: { vaultAddress: string; reason?: string; score?: number }[],
    candidates: VaultCandidate[],
    highCount: number,
    totalCount: number
):
    | { highConfidence: VaultRecommendation[]; lowConfidence: VaultRecommendation[] }
    | null {
    const map = new Map(
        candidates.map((candidate) => [
            candidate.vaultAddress.toLowerCase(),
            candidate,
        ])
    );

    const seen = new Set<string>();
    const highRecs: VaultRecommendation[] = [];
    const lowRecs: VaultRecommendation[] = [];

    for (const entry of high) {
        const address = entry.vaultAddress?.toLowerCase();
        if (!address || seen.has(address)) continue;
        const candidate = map.get(address);
        if (!candidate) continue;
        seen.add(address);
        highRecs.push(
            buildRecommendation(candidate, "high", entry.score, entry.reason)
        );
        if (highRecs.length >= highCount) break;
    }

    for (const entry of low) {
        const address = entry.vaultAddress?.toLowerCase();
        if (!address || seen.has(address)) continue;
        const candidate = map.get(address);
        if (!candidate) continue;
        seen.add(address);
        lowRecs.push(
            buildRecommendation(candidate, "low", entry.score, entry.reason)
        );
        if (highRecs.length + lowRecs.length >= totalCount) break;
    }

    const totalSelected = highRecs.length + lowRecs.length;
    if (totalSelected < Math.min(totalCount, candidates.length)) {
        return null;
    }
    return { highConfidence: highRecs, lowConfidence: lowRecs };
}

function allocateGroups(
    high: VaultRecommendation[],
    low: VaultRecommendation[],
    highPct: number,
    lowPct: number
): { highConfidence: VaultRecommendation[]; lowConfidence: VaultRecommendation[] } {
    const total = highPct + lowPct;
    const normalizedHigh = total > 0 ? (highPct / total) * 100 : 70;
    const normalizedLow = total > 0 ? (lowPct / total) * 100 : 30;

    return {
        highConfidence: applyAllocation(high, normalizedHigh),
        lowConfidence: applyAllocation(low, normalizedLow),
    };
}

function applyAllocation(
    items: VaultRecommendation[],
    totalPct: number
): VaultRecommendation[] {
    if (!items.length) return items;
    const per = totalPct / items.length;
    const rounded = items.map((item) => ({
        ...item,
        allocationPct: round(per, 2),
    }));
    const sum = rounded.reduce((acc, item) => acc + item.allocationPct, 0);
    const diff = round(totalPct - sum, 2);
    if (rounded.length && Math.abs(diff) > 0) {
        rounded[0].allocationPct = round(rounded[0].allocationPct + diff, 2);
    }
    return rounded;
}

function round(value: number, digits: number): number {
    const factor = Math.pow(10, digits);
    return Math.round(value * factor) / factor;
}
