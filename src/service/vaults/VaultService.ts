import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import type { UserLedgerUpdate } from "../trade/HyperliquidConnector";
import { OpenAIService } from "../openai/OpenAIService";
import type { OpenAIRanking } from "../openai/OpenAIService";
import { logger } from "../utils/logger";
import type {
    CandidatesResult,
    RecommendationSet,
    VaultCandidate,
    VaultFilters,
    VaultHistory,
    VaultMetrics,
    VaultRecommendation,
    PlatformHistoryEntry,
    PlatformHistoryResponse,
    PlatformMetricsResponse,
    TimeSeriesPoint,
    UserPortfolioSummary,
    UserPositionsResponse,
    UserVaultHistory,
    UserVaultsResponse,
} from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const RESERVED_NAMES = new Set(
    (process.env.VAULT_RESERVED_NAMES ??
        "Hyperliquidity Provider (HLP),Hyperliquidity Trader (HLT),HLP Strategy A,HLP Strategy B,HLP Strategy X,HLP Liquidator,HLP Liquidator 2,HLP Liquidator 3,HLP Liquidator 4")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
);

const DEFAULT_FILTERS: VaultFilters = {
    minTvl: readNumberEnv(process.env.VAULT_MIN_TVL, 10000),
    minAgeDays: readNumberEnv(process.env.VAULT_MIN_AGE_DAYS, 21),
    minFollowers: readNumberEnv(process.env.VAULT_MIN_FOLLOWERS, 10),
    minTrades7d: readNumberEnv(process.env.VAULT_MIN_TRADES_7D, 5),
    requirePositiveWeeklyPnl:
        (process.env.VAULT_REQUIRE_POSITIVE_WEEKLY_PNL ?? "false") === "true",
    requirePositiveMonthlyPnl:
        (process.env.VAULT_REQUIRE_POSITIVE_MONTHLY_PNL ?? "false") === "true",
    requireDepositsOpen: true
};

const CANDIDATE_CACHE_TTL_MS = readNumberEnv(
    process.env.VAULT_CACHE_TTL_MS,
    5 * 60 * 1000
);
const CANDIDATE_LIMIT = readNumberEnv(
    process.env.VAULT_CANDIDATE_LIMIT,
    100
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
const MIN_POSITION_USD = readNumberEnv(process.env.MIN_POSITION_USD, 1);
const LAUNCH_DATE_ISO =
    process.env.LAUNCH_DATE ?? "2026-01-06T22:17:00+01:00";
const LAUNCH_DATE_MS = readDateMsEnv(
    LAUNCH_DATE_ISO,
    "2026-01-06T22:17:00+01:00"
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
    private static userVaultsCache: Map<string, Cached<UserVaultsResponse>> =
        new Map();
    private static userPortfolioCache: Map<
        string,
        Cached<UserPortfolioSummary | null>
    > = new Map();

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
        const prefiltered: {
            vault: any;
            summary: any;
            tvl: number;
            ageDays: number;
            performance: ReturnType<typeof HyperliquidConnector.parsePerformance>;
        }[] = [];

        for (const vault of rawVaults) {
            const summary = vault.summary;
            if (!summary || summary.isClosed) continue;
            if (RESERVED_NAMES.has(summary.name?.trim?.() ?? summary.name)) continue;

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

            prefiltered.push({
                vault,
                summary,
                tvl,
                ageDays,
                performance,
            });
        }

        prefiltered.sort((a, b) => b.tvl - a.tvl);
        const limited =
            CANDIDATE_LIMIT > 0 ? prefiltered.slice(0, CANDIDATE_LIMIT) : prefiltered;

        const candidates: VaultCandidate[] = [];
        for (const entry of limited) {
            const details = await HyperliquidConnector.getVaultDetails(
                entry.summary.vaultAddress
            );
            const followers =
                Array.isArray(details?.followers)
                    ? details?.followers.length
                    : null;
            const allowDeposits =
                typeof details?.allowDeposits === "boolean"
                    ? details.allowDeposits
                    : null;

            //wait a bit to avoid rate limits
            await new Promise((resolve) => setTimeout(resolve, 200));

            const tradesLast7d =
                filters.minTrades7d > 0
                    ? await HyperliquidConnector.getVaultTradesCount(
                          entry.summary.vaultAddress,
                          7
                      )
                    : null;

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

            logger.info("Found vault candidate", { name: entry.summary.name });
            candidates.push({
                vaultAddress: entry.summary.vaultAddress,
                name: entry.summary.name,
                tvl: entry.tvl,
                ageDays: entry.ageDays,
                isClosed: entry.summary.isClosed,
                weeklyPnl: entry.performance.weeklyPnl,
                monthlyPnl: entry.performance.monthlyPnl,
                allTimePnl: entry.performance.allTimePnl,
                followers,
                allowDeposits,
                tradesLast7d,
                performance: entry.performance,
                raw: entry.vault,
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

    static async getRecommendations(
        options: RecommendationOptions = {}
    ): Promise<RecommendationSet> {
        logger.info("Generating vault recommendations");

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
        let aiRankingResult: OpenAIRanking | null = null;

        if (totalCount > 0) {
            logger.info("Ranking vault candidates with OpenAI");
            aiRankingResult = await OpenAIService.rankVaults(
                candidates,
                totalCount,
                highCount
            );
            if (aiRankingResult) {
                const mapped = mapOpenAiRanking(
                    aiRankingResult.highConfidence,
                    aiRankingResult.lowConfidence,
                    candidates,
                    highCount,
                    totalCount,
                    aiRankingResult.allocationMap
                );
                if (mapped) {
                    source = "openai";
                    model = aiRankingResult.model;
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

        const allocationBuckets =
            source === "openai"
                ? {
                      highConfidence,
                      lowConfidence,
                  }
                : allocateGroups(
                      highConfidence,
                      lowConfidence,
                      HIGH_ALLOC_PCT,
                      LOW_ALLOC_PCT
                  );

        const result: RecommendationSet = {
            generatedAt: new Date().toISOString(),
            source,
            model,
            highConfidence: allocationBuckets.highConfidence,
            lowConfidence: allocationBuckets.lowConfidence,
            candidates: {
                count: candidates.length,
                generatedAt: candidatesResult.generatedAt,
            },
            suggestedAllocations: aiRankingResult?.suggestedAllocations,
        };
        logger.info("Generated vault recommendations", {
            source,
            model,
            total: result.highConfidence.length + result.lowConfidence.length,
        });
        return result;
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
        const adjusted = rebasePortfolioPnl(result, LAUNCH_DATE_MS);
        this.userPortfolioCache.set(key, { fetchedAt: now, result: adjusted });
        return adjusted;
    }

    static async getUserPositions(
        userAddress: string,
        options: { refresh?: boolean } = {}
    ): Promise<UserPositionsResponse> {
        const vaults = await this.getUserVaults(userAddress, {
            refresh: options.refresh,
            includeHistory: true,
        });
        const ledgerUpdates = await HyperliquidConnector.getUserVaultLedgerUpdates(
            userAddress as `0x${string}`
        );
        const ledgerByVault = buildLedgerByVault(ledgerUpdates, MIN_POSITION_USD);
        const portfolio = await this.getUserPortfolio(userAddress, {
            refresh: options.refresh,
        });
        const perpsEquity = extractAccountEquity(portfolio);
        const investedUsd = vaults.items.reduce((sum, entry) => {
            const equity = Number.isFinite(entry.equity) ? entry.equity : 0;
            return equity >= MIN_POSITION_USD ? sum + equity : sum;
        }, 0);
        const totalCapital =
            Number.isFinite(perpsEquity) ? perpsEquity + investedUsd : null;
        const positions = vaults.items
            .filter(
                (entry) =>
                    Number.isFinite(entry.equity) && entry.equity >= MIN_POSITION_USD
            )
            .map((entry) => {
                const amountUsd = Number.isFinite(entry.equity)
                    ? entry.equity
                    : null;
                const ledger = ledgerByVault.get(
                    entry.vaultAddress.toLowerCase()
                );
                const pnlUsd = pickPnl(
                    entry.userPerformance,
                    entry.userHistory,
                    amountUsd,
                    ledger
                );
                const entryUsd = deriveEntryUsd(amountUsd, pnlUsd, ledger);
                const roePct =
                    entryUsd && entryUsd > 0 && pnlUsd !== null
                        ? (pnlUsd / entryUsd) * 100
                        : null;
                const sizePct =
                    totalCapital && totalCapital > 0 && amountUsd !== null
                        ? (amountUsd / totalCapital) * 100
                        : null;
                return {
                    vaultAddress: entry.vaultAddress,
                    vaultName: entry.vaultName,
                    sizePct: sizePct !== null ? round(sizePct, 4) : null,
                    amountUsd: amountUsd !== null ? round(amountUsd, 6) : null,
                    pnlUsd: pnlUsd !== null ? round(pnlUsd, 6) : null,
                    roePct: roePct !== null ? round(roePct, 4) : null,
                };
            });
        const netPnl = positions.reduce(
            (sum, entry) => sum + (Number.isFinite(entry.pnlUsd) ? entry.pnlUsd : 0),
            0
        );
        return {
            userAddress,
            totalPositions: positions.length,
            totalCapitalUsd: totalCapital !== null ? round(totalCapital, 6) : null,
            totalInvestedUsd:
                Number.isFinite(investedUsd) ? round(investedUsd, 6) : null,
            netPnlUsd: Number.isFinite(netPnl) ? round(netPnl, 6) : null,
            positions,
        };
    }

    static async getPlatformHistory(
        options: { refresh?: boolean; page?: number; pageSize?: number } = {}
    ): Promise<PlatformHistoryResponse> {
        const wallet = process.env.WALLET as `0x${string}` | undefined;
        if (!wallet) {
            throw new Error("WALLET is not set");
        }
        const updates = await HyperliquidConnector.getUserVaultLedgerUpdates(wallet);
        const filtered = updates.filter(
            (entry) =>
                Number.isFinite(entry.time) &&
                entry.time >= LAUNCH_DATE_MS &&
                Math.abs(entry.usdc) >= MIN_POSITION_USD
        );
        const vaultNames = await fetchVaultNames(
            filtered.map((entry) => entry.vault)
        );
        const entries: PlatformHistoryEntry[] = filtered.map((entry) => {
            const amountUsd = Number.isFinite(entry.usdc)
                ? round(entry.usdc, 6)
                : null;
            const realized =
                entry.type === "vaultWithdraw" &&
                Number.isFinite(entry.netWithdrawnUsd) &&
                Number.isFinite(entry.basisUsd)
                    ? round(
                          Number(entry.netWithdrawnUsd) - Number(entry.basisUsd),
                          6
                      )
                    : null;
            return {
                time: entry.time,
                type: entry.type,
                vaultAddress: entry.vault,
                vaultName: vaultNames.get(entry.vault.toLowerCase()),
                amountUsd,
                realizedPnlUsd: realized,
            };
        });
        entries.sort((a, b) => b.time - a.time);
        const pageSize = clampInt(options.pageSize ?? 15, 1, 100);
        const total = entries.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const page = clampInt(options.page ?? 1, 1, totalPages);
        const start = (page - 1) * pageSize;
        const pageEntries = entries.slice(start, start + pageSize);
        return {
            userAddress: wallet,
            total,
            page,
            pageSize,
            totalPages,
            entries: pageEntries,
        };
    }

    static async getPlatformPerformanceMetrics(
        options: { refresh?: boolean } = {}
    ): Promise<PlatformMetricsResponse> {
        const wallet = process.env.WALLET as `0x${string}` | undefined;
        if (!wallet) {
            throw new Error("WALLET is not set");
        }
        const [portfolio, positions, updates] = await Promise.all([
            this.getPlatformPortfolio({ refresh: options.refresh }),
            this.getPlatformPositions({ refresh: options.refresh }),
            HyperliquidConnector.getUserVaultLedgerUpdates(wallet),
        ]);

        const now = Date.now();
        const accountSeries = normalizeSeries(
            portfolio?.history?.accountValue?.points
        );
        const pnlSeries = normalizeSeries(portfolio?.history?.pnl?.points);
        const filteredSeries = accountSeries.filter(
            (point) => point.timestamp >= LAUNCH_DATE_MS
        );
        const currentAccountValue = latestSeriesValue(accountSeries);
        const tvlUsd =
            currentAccountValue ??
            (Number.isFinite(positions.totalInvestedUsd)
                ? (positions.totalInvestedUsd as number)
                : null);
        const value30d = findValueAtOrBefore(
            accountSeries,
            now - 30 * MS_PER_DAY
        );
        const tvlChange30dUsd =
            Number.isFinite(currentAccountValue) && Number.isFinite(value30d)
                ? (currentAccountValue as number) - (value30d as number)
                : null;
        const pnlValue30d = findValueAtOrBefore(
            pnlSeries,
            now - 30 * MS_PER_DAY
        );
        const pnlLatest = latestSeriesValue(pnlSeries);
        const pnlChange30dUsd =
            Number.isFinite(pnlLatest) && Number.isFinite(pnlValue30d)
                ? (pnlLatest as number) - (pnlValue30d as number)
                : null;
        const capital30d =
            Number.isFinite(value30d) && Number.isFinite(pnlValue30d)
                ? (value30d as number) - (pnlValue30d as number)
                : null;
        const pnlChange30dPct =
            Number.isFinite(pnlChange30dUsd) &&
            Number.isFinite(capital30d) &&
            (capital30d as number) > 0
                ? ((pnlChange30dUsd as number) / (capital30d as number)) * 100
                : null;
        const maxDrawdownPct = calcMaxDrawdownPct(filteredSeries);
        const winRatePct = calcWinRatePct(updates, LAUNCH_DATE_MS, MIN_POSITION_USD);

        return {
            userAddress: wallet,
            tvlUsd: tvlUsd !== null ? round(tvlUsd, 6) : null,
            tvlChange30dUsd:
                tvlChange30dUsd !== null ? round(tvlChange30dUsd, 6) : null,
            pnlChange30dPct:
                pnlChange30dPct !== null ? round(pnlChange30dPct, 4) : null,
            winRatePct: winRatePct !== null ? round(winRatePct, 4) : null,
            maxDrawdownPct:
                maxDrawdownPct !== null ? round(maxDrawdownPct, 4) : null,
            since: new Date(LAUNCH_DATE_MS).toISOString(),
            calculatedAt: new Date().toISOString(),
        };
    }

    static async getPlatformPositions(
        options: { refresh?: boolean } = {}
    ): Promise<UserPositionsResponse> {
        const wallet = process.env.WALLET as `0x${string}` | undefined;
        if (!wallet) {
            throw new Error("WALLET is not set");
        }
        return this.getUserPositions(wallet, options);
    }

    static async getPlatformPortfolio(
        options: { refresh?: boolean } = {}
    ): Promise<UserPortfolioSummary | null> {
        const wallet = process.env.WALLET as `0x${string}` | undefined;
        if (!wallet) {
            throw new Error("WALLET is not set");
        }
        return this.getUserPortfolio(wallet, options);
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

function readDateMsEnv(value: string | undefined, fallbackIso: string): number {
    const raw = value && value.trim().length > 0 ? value : fallbackIso;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
    const fallback = Date.parse(fallbackIso);
    return Number.isFinite(fallback) ? fallback : Date.now();
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

function extractAccountEquity(
    portfolio: UserPortfolioSummary | null
): number | null {
    const equity = portfolio?.metrics?.accountEquity;
    if (!equity) return null;
    return (
        pickFinite(equity.allTime) ??
        pickFinite(equity["30d"]) ??
        pickFinite(equity["7d"]) ??
        pickFinite(equity["24h"])
    );
}

type LedgerSummary = {
    deposits: number;
    withdrawals: number;
    currentDeposits: number;
};

function pickPnl(
    perf: { pnl?: number | null; allTimePnl?: number | null } | null,
    history: { pnl?: { points: { timestamp: number; value: number }[] } | null } | undefined,
    amountUsd: number | null,
    ledger?: LedgerSummary
) {
    const ledgerPnl = calcUnrealizedPnlFromLedger(amountUsd, ledger);
    if (Number.isFinite(ledgerPnl)) return ledgerPnl as number;
    if (perf) {
        if (Number.isFinite(Number(perf.pnl))) return Number(perf.pnl);
        if (Number.isFinite(Number(perf.allTimePnl))) return Number(perf.allTimePnl);
    }
    const points = history?.pnl?.points;
    if (Array.isArray(points) && points.length) {
        const last = points[points.length - 1]?.value;
        if (Number.isFinite(Number(last))) return Number(last);
    }
    return null;
}

function deriveEntryUsd(
    amountUsd: number | null,
    pnlUsd: number | null,
    ledger?: LedgerSummary
): number | null {
    if (ledger && ledger.currentDeposits > 0) {
        return ledger.currentDeposits;
    }
    if (amountUsd !== null && pnlUsd !== null) {
        const entryUsd = amountUsd - pnlUsd;
        return Number.isFinite(entryUsd) ? entryUsd : null;
    }
    return amountUsd;
}

function buildLedgerByVault(
    updates: { vault: string; type: string; usdc: number; time?: number }[],
    minPositionUsd: number
): Map<string, LedgerSummary> {
    const grouped = new Map<string, { vault: string; type: string; usdc: number; time: number }[]>();
    for (const update of updates) {
        const vault = update.vault?.toLowerCase();
        if (!vault) continue;
        const time = Number(update.time);
        if (!Number.isFinite(time)) continue;
        const bucket = grouped.get(vault) ?? [];
        bucket.push({
            vault,
            type: update.type,
            usdc: update.usdc,
            time,
        });
        grouped.set(vault, bucket);
    }

    const map = new Map<string, LedgerSummary>();
    for (const [vault, entries] of grouped.entries()) {
        entries.sort((a, b) => a.time - b.time);
        let deposits = 0;
        let withdrawals = 0;
        let current = 0;
        for (const entry of entries) {
            if (entry.type === "vaultDeposit") {
                deposits += entry.usdc;
                current += entry.usdc;
            } else if (entry.type === "vaultWithdraw") {
                withdrawals += entry.usdc;
                current -= entry.usdc;
            }
            if (current < minPositionUsd) {
                current = 0;
            }
        }
        map.set(vault, { deposits, withdrawals, currentDeposits: current });
    }
    return map;
}

function calcUnrealizedPnlFromLedger(
    amountUsd: number | null,
    ledger?: LedgerSummary
): number | null {
    if (!ledger) return null;
    const netDeposits = ledger.currentDeposits;
    if (!Number.isFinite(netDeposits) || netDeposits <= 0) return null;
    if (!Number.isFinite(amountUsd)) return null;
    return amountUsd - netDeposits;
}

async function fetchVaultNames(
    vaults: string[]
): Promise<Map<string, string>> {
    const unique = Array.from(
        new Set(
            vaults
                .filter((vault) => typeof vault === "string")
                .map((vault) => vault.toLowerCase())
        )
    );
    if (!unique.length) return new Map();
    const details = await mapWithConcurrency(unique, 3, async (vault) => {
        const info = await HyperliquidConnector.getVaultDetails(
            vault as `0x${string}`
        );
        return { vault, name: info?.name ?? "" };
    });
    const map = new Map<string, string>();
    for (const entry of details) {
        if (entry.name) map.set(entry.vault, entry.name);
    }
    return map;
}

function pickFinite(value: number | null | undefined): number | null {
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

function clampInt(value: number, min: number, max: number): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return min;
    return Math.min(max, Math.max(min, Math.floor(num)));
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

function mapOpenAiRanking(
    high: { vaultAddress: string; reason?: string; score?: number }[],
    low: { vaultAddress: string; reason?: string; score?: number }[],
    candidates: VaultCandidate[],
    highCount: number,
    totalCount: number,
    allocationMap?: Record<string, number>
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
        const allocationPct =
            allocationMap && Object.prototype.hasOwnProperty.call(allocationMap, address)
                ? allocationMap[address]
                : 0;
        highRecs.push(
            buildRecommendation(
                candidate,
                "high",
                entry.score,
                entry.reason,
                allocationPct
            )
        );
        if (highRecs.length >= highCount) break;
    }

    for (const entry of low) {
        const address = entry.vaultAddress?.toLowerCase();
        if (!address || seen.has(address)) continue;
        const candidate = map.get(address);
        if (!candidate) continue;
        seen.add(address);
        const allocationPct =
            allocationMap && Object.prototype.hasOwnProperty.call(allocationMap, address)
                ? allocationMap[address]
                : 0;
        lowRecs.push(
            buildRecommendation(
                candidate,
                "low",
                entry.score,
                entry.reason,
                allocationPct
            )
        );
        if (highRecs.length + lowRecs.length >= totalCount) break;
    }

    const totalSelected = highRecs.length + lowRecs.length;
    if (totalSelected < Math.min(totalCount, candidates.length)) {
        return null;
    }
    return { highConfidence: highRecs, lowConfidence: lowRecs };
}

function buildRecommendation(
    candidate: VaultCandidate,
    confidence: "high" | "low",
    score?: number,
    reason?: string,
    allocationPct?: number
): VaultRecommendation {
    return {
        vaultAddress: candidate.vaultAddress,
        name: candidate.name,
        confidence,
        allocationPct: Number.isFinite(Number(allocationPct)) ? Number(allocationPct) : 0,
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

function normalizeSeries(
    points?: TimeSeriesPoint[] | null
): TimeSeriesPoint[] {
    if (!Array.isArray(points)) return [];
    return points
        .map((point) => ({
            timestamp: Number(point.timestamp),
            value: Number(point.value),
        }))
        .filter(
            (point) =>
                Number.isFinite(point.timestamp) && Number.isFinite(point.value)
        )
        .sort((a, b) => a.timestamp - b.timestamp);
}

function latestSeriesValue(points: TimeSeriesPoint[]): number | null {
    if (!points.length) return null;
    const last = points[points.length - 1];
    return Number.isFinite(last?.value) ? last.value : null;
}

function findValueAtOrBefore(
    points: TimeSeriesPoint[],
    target: number
): number | null {
    if (!Number.isFinite(target) || !points.length) return null;
    let value: number | null = null;
    for (const point of points) {
        if (point.timestamp <= target) {
            value = point.value;
        } else {
            break;
        }
    }
    return Number.isFinite(value) ? (value as number) : null;
}

function calcMaxDrawdownPct(points: TimeSeriesPoint[]): number | null {
    if (points.length < 2) return null;
    let peak = points[0].value;
    if (!Number.isFinite(peak) || peak <= 0) return null;
    let maxDrawdown = 0;
    for (const point of points) {
        const value = point.value;
        if (!Number.isFinite(value)) continue;
        if (value > peak) {
            peak = value;
            continue;
        }
        const drawdown = (value - peak) / peak;
        if (drawdown < maxDrawdown) {
            maxDrawdown = drawdown;
        }
    }
    return maxDrawdown * 100;
}


function calcWinRatePct(
    updates: UserLedgerUpdate[],
    sinceMs: number,
    minUsd: number
): number | null {
    const realized = updates.filter((entry) => {
        if (entry.type !== "vaultWithdraw") return false;
        if (!Number.isFinite(entry.time) || entry.time < sinceMs) return false;
        if (Math.abs(entry.usdc) < minUsd) return false;
        return (
            Number.isFinite(entry.netWithdrawnUsd) &&
            Number.isFinite(entry.basisUsd)
        );
    });
    if (!realized.length) return null;
    const wins = realized.filter(
        (entry) =>
            Number(entry.netWithdrawnUsd) - Number(entry.basisUsd) > 0
    ).length;
    return (wins / realized.length) * 100;
}

function rebasePortfolioPnl(
    portfolio: UserPortfolioSummary | null,
    sinceMs: number
): UserPortfolioSummary | null {
    if (!portfolio?.history?.pnl?.points) return portfolio;
    const points = normalizeSeries(portfolio.history.pnl.points);
    if (!points.length) return portfolio;
    const baseline =
        findValueAtOrBefore(points, sinceMs) ??
        points[0]?.value ??
        0;
    const rebased = points
        .filter((point) => point.timestamp >= sinceMs)
        .map((point) => ({
            timestamp: point.timestamp,
            value: round(point.value - baseline, 8),
        }));
    return {
        ...portfolio,
        history: {
            ...portfolio.history,
            pnl: { points: rebased },
        },
    };
}
