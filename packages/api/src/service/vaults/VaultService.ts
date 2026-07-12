import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import type { UserLedgerUpdate } from "../trade/HyperliquidConnector";
import { ClaudeService } from "../claude/ClaudeService";
import type { ClaudeRanking } from "../claude/ClaudeService";
import { logger } from "../utils/logger";
import {
    readPositionAccountAggregate,
    readPortfolioSnapshotAt,
    readWinRateAggregate,
    readMaxDrawdownFromSeries,
    type PositionAccountAggregate,
} from "../../db/TraceService";
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
    UserVaultEntry,
    UserVaultsResponse,
} from "./types";
import {
    LedgerSummary,
    MS_PER_DAY,
    ageInDays,
    applyAllocation,
    buildLedgerByVault,
    calcInceptionPnlPct,
    calcPnlPct,
    calcUnrealizedPnlFromLedger,
    calcVaultMaxDrawdownPct,
    calcWinRatePct,
    deriveEntryUsd,
    extractAccountEquity,
    findValueAtOrBefore,
    latestSeriesValue,
    maxDrawdownFromPnls,
    normalizeSeries,
    pickPnl,
    rebasePortfolioPnl,
    round,
    safeRatio,
    scoreCandidate,
    toSignedDrawdownPct,
} from "./vaultMath";

const RESERVED_NAMES = new Set([
    "Hyperliquidity Provider (HLP)",
    "Hyperliquidity Trader (HLT)",
    "HLP Strategy A",
    "HLP Strategy B",
    "HLP Strategy X",
    "HLP Liquidator",
    "HLP Liquidator 2",
    "HLP Liquidator 3",
    "HLP Liquidator 4",
]);

const DEFAULT_FILTERS: VaultFilters = {
    minTvl: 10000,
    minAgeDays: 50,
    minFollowers: 10,
    minTrades7d: 5,
    requirePositiveWeeklyPnl: false,
    requirePositiveMonthlyPnl: false,
    requirePositiveAllTimePnl: true,
    maxDrawdownPct: 30,
    maxMarginUtilPct: 50,
    requireDepositsOpen: true,
};

const CANDIDATE_CACHE_TTL_MS = 5 * 60 * 1000;
const CANDIDATE_LIMIT = 100;
const RECOMMENDATION_COUNT = 15;
const HIGH_CONF_COUNT = 8;
// Matches the executor's barbell in DepositService (DEFAULT_HIGH_PCT / DEFAULT_LOW_PCT).
const HIGH_ALLOC_PCT = 80;
const LOW_ALLOC_PCT = 20;
const USER_VAULTS_CACHE_TTL_MS = 5 * 60 * 1000;
const USER_VAULTS_CONCURRENCY = 3;
const USER_PORTFOLIO_CACHE_TTL_MS = 2 * 60 * 1000;
const MIN_POSITION_USD = 1;
const LAUNCH_DATE_MS = new Date("2026-01-06T22:17:00+01:00").getTime();

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

    static clearUserCaches(): void {
        this.userVaultsCache.clear();
        this.userPortfolioCache.clear();
    }

    static async getCandidates(options: CandidateOptions = {}): Promise<CandidatesResult> {
        logger.info("Searching for vault candidates", {
            refresh: options.refresh,
            filters: options.filters,
        });
        const filters = mergeFilters(options.filters);
        const now = Date.now();
        if (
            !options.refresh &&
            this.candidatesCache &&
            now - this.candidatesCache.fetchedAt < CANDIDATE_CACHE_TTL_MS &&
            sameFilters(this.candidatesCache.result.filters, filters)
        ) {
            const cacheAgeMs = now - this.candidatesCache.fetchedAt;
            logger.info("Using cached candidates", {
                count: this.candidatesCache.result.count,
                cacheAgeSec: Math.round(cacheAgeMs / 1000),
            });
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
            if (
                filters.requirePositiveAllTimePnl &&
                !(performance.allTimePnl !== null && performance.allTimePnl > 0)
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

        logger.info("Vault prefilter complete", {
            rawVaults: rawVaults.length,
            passedPrefilter: prefiltered.length,
            filtered: rawVaults.length - prefiltered.length,
            filters: {
                minTvl: filters.minTvl,
                minAgeDays: filters.minAgeDays,
                requirePositiveWeeklyPnl: filters.requirePositiveWeeklyPnl,
                requirePositiveMonthlyPnl: filters.requirePositiveMonthlyPnl,
                requirePositiveAllTimePnl: filters.requirePositiveAllTimePnl,
                maxDrawdownPct: filters.maxDrawdownPct,
                maxMarginUtilPct: filters.maxMarginUtilPct,
            },
        });

        prefiltered.sort((a, b) => b.tvl - a.tvl);
        const limited =
            CANDIDATE_LIMIT > 0 ? prefiltered.slice(0, CANDIDATE_LIMIT) : prefiltered;

        // Inter-call delay against Hyperliquid INFO API. Tunable; default 600ms is
        // conservative enough to avoid 429 storms on warmup with ~80 candidates.
        const HL_API_DELAY_MS = 600;
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

            await sleep(HL_API_DELAY_MS);

            const tradesLast7d =
                filters.minTrades7d > 0
                    ? await HyperliquidConnector.getVaultTradesCount(
                          entry.summary.vaultAddress,
                          7
                      )
                    : null;

            await sleep(HL_API_DELAY_MS);
            const accountSummary = await HyperliquidConnector.getVaultAccountSummary(
                entry.summary.vaultAddress
            );
            // Final inter-candidate spacer so the next iteration doesn't fire
            // back-to-back after the third call.
            await sleep(HL_API_DELAY_MS);
            const currentPositions = Array.isArray(accountSummary?.assetPositions)
                ? accountSummary.assetPositions.length
                : 0;

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
            // Skip vaults with no active positions
            if (currentPositions === 0) {
                logger.info("Skipping vault candidate (no active positions)", {
                    name: entry.summary.name,
                    vaultAddress: entry.summary.vaultAddress,
                });
                continue;
            }
            // Max drawdown filter: reject vaults with excessive historical drawdown
            if (filters.maxDrawdownPct > 0) {
                const dd = maxDrawdownFromPnls(entry.vault.pnls, entry.tvl);
                if (dd !== null && dd > filters.maxDrawdownPct) {
                    logger.info("Skipping vault candidate (drawdown too high)", {
                        name: entry.summary.name,
                        vaultAddress: entry.summary.vaultAddress,
                        drawdownPct: round(dd, 2),
                        maxAllowed: filters.maxDrawdownPct,
                    });
                    continue;
                }
            }
            // Margin utilization filter: reject overly leveraged vaults
            if (filters.maxMarginUtilPct > 0) {
                const marginUtil = accountSummary?.marginUtilPct;
                if (marginUtil !== null && marginUtil !== undefined && marginUtil > filters.maxMarginUtilPct) {
                    logger.info("Skipping vault candidate (margin utilization too high)", {
                        name: entry.summary.name,
                        vaultAddress: entry.summary.vaultAddress,
                        marginUtilPct: round(marginUtil, 2),
                        maxAllowed: filters.maxMarginUtilPct,
                    });
                    continue;
                }
            }

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
        logger.info("Found vault candidates", {
            count: candidates.length,
            detailsScanned: limited.length,
            filteredInDetailPass: limited.length - candidates.length,
            topByTvl: candidates.slice(0, 5).map(c => ({
                name: c.name,
                tvl: c.tvl,
                weeklyPnl: c.weeklyPnl,
                tradesLast7d: c.tradesLast7d,
            })),
        });
        return result;
    }

    static async getRecommendations(
        options: RecommendationOptions = {}
    ): Promise<RecommendationSet> {
        logger.info("Generating vault recommendations", {
            refreshCandidates: options.refreshCandidates,
            refresh: options.refresh,
            recommendationCount: RECOMMENDATION_COUNT,
            highConfCount: HIGH_CONF_COUNT,
        });

        const candidatesResult = await this.getCandidates({
            refresh: options.refreshCandidates,
        });
        const candidates = candidatesResult.items;
        const totalCount = Math.min(RECOMMENDATION_COUNT, candidates.length);
        const highCount = Math.min(HIGH_CONF_COUNT, totalCount);

        logger.info("Recommendation parameters", {
            candidateCount: candidates.length,
            totalCount,
            highCount,
            lowCount: totalCount - highCount,
        });

        let source: "claude" | "heuristic" = "heuristic";
        let model: string | undefined;
        let highConfidence: VaultRecommendation[] = [];
        let lowConfidence: VaultRecommendation[] = [];
        let aiRankingResult: ClaudeRanking | null = null;

        if (totalCount > 0) {
            logger.info("Ranking vault candidates with Claude");
            aiRankingResult = await ClaudeService.rankVaults(
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
                    source = "claude";
                    model = aiRankingResult.model;
                    highConfidence = mapped.highConfidence;
                    lowConfidence = mapped.lowConfidence;
                }
            }

            if (!highConfidence.length && !lowConfidence.length) {
                logger.warn("Claude ranking returned no results, falling back to heuristic", {
                    aiRankingResult: aiRankingResult ? "returned-but-empty" : "null",
                    claudeHighCount: aiRankingResult?.highConfidence?.length,
                    claudeLowCount: aiRankingResult?.lowConfidence?.length,
                    claudeHighAddrs: aiRankingResult?.highConfidence?.map(e => e.vaultAddress),
                    claudeLowAddrs: aiRankingResult?.lowConfidence?.map(e => e.vaultAddress),
                    candidatesCount: candidates.length,
                    candidateAddrs: candidates.slice(0, 5).map(c => c.vaultAddress),
                });
                const ranked = rankByHeuristic(candidates, totalCount, highCount);
                highConfidence = ranked.highConfidence;
                lowConfidence = ranked.lowConfidence;
            }
        }

        const allocationBuckets =
            source === "claude"
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
            stage1Scores: aiRankingResult?.stage1Scores,
        };
        logger.info("Generated vault recommendations", {
            source,
            model,
            total: result.highConfidence.length + result.lowConfidence.length,
            highCount: result.highConfidence.length,
            lowCount: result.lowConfidence.length,
            highConfidence: result.highConfidence.map(r => ({
                name: r.name,
                score: r.score,
                allocationPct: r.allocationPct,
                address: r.vaultAddress,
            })),
            lowConfidence: result.lowConfidence.map(r => ({
                name: r.name,
                score: r.score,
                allocationPct: r.allocationPct,
                address: r.vaultAddress,
            })),
            suggestedAllocations: result.suggestedAllocations,
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
        const [vaults, ledgerUpdates, portfolio] = await Promise.all([
            this.getUserVaults(userAddress, {
                refresh: options.refresh,
                includeHistory: true,
            }),
            HyperliquidConnector.getUserVaultLedgerUpdates(
                userAddress as `0x${string}`
            ),
            this.getUserPortfolio(userAddress, {
                refresh: options.refresh,
            }),
        ]);
        const ledgerByVault = buildLedgerByVault(ledgerUpdates, MIN_POSITION_USD);
        // Misnamed: HL's `accountEquity` is the *total* manager account value —
        // perps wallet + sum of vault equities — NOT perps-only. Adding
        // `investedUsd` (vault equities) below would double-count, so we use
        // accountEquity directly as totalCapital.
        const accountEquity = extractAccountEquity(portfolio);
        const investedUsd = vaults.items.reduce((sum, entry) => {
            const equity = Number.isFinite(entry.equity) ? entry.equity : 0;
            return equity >= MIN_POSITION_USD ? sum + equity : sum;
        }, 0);
        const totalCapital = Number.isFinite(accountEquity)
            ? (accountEquity as number)
            : null;
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
                    investedUsd > 0 && amountUsd !== null
                        ? (amountUsd / investedUsd) * 100
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
        const [portfolio, positions, updates, vaults, ourBooks, winRateBooks] =
            await Promise.all([
                this.getPlatformPortfolio({ refresh: options.refresh }),
                this.getPlatformPositions({ refresh: options.refresh }),
                HyperliquidConnector.getUserVaultLedgerUpdates(wallet),
                this.getUserVaults(wallet, {
                    refresh: options.refresh,
                    includeHistory: true,
                }),
                readPositionAccountAggregate().catch(() => null),
                readWinRateAggregate().catch(() => null),
            ]);

        const now = Date.now();
        const accountSeries = normalizeSeries(
            portfolio?.history?.accountValue?.points
        );
        const currentAccountValue = latestSeriesValue(accountSeries);
        // Vault-equity TVL (sum of open vault equities). HL's portfolio
        // accountValueHistory is perp-wallet equity, not vault equity — using it
        // in unrealized-PnL = (equity − basis) gives a nonsensical value
        // because perp_wallet moves opposite to vault basis on rebalances.
        const vaultEquityUsd = Number.isFinite(positions.totalInvestedUsd)
            ? (positions.totalInvestedUsd as number)
            : null;
        const tvlUsd = vaultEquityUsd ?? currentAccountValue;
        const value30d = findValueAtOrBefore(
            accountSeries,
            now - 30 * MS_PER_DAY
        );
        const tvlChange30dUsd =
            Number.isFinite(currentAccountValue) && Number.isFinite(value30d)
                ? (currentAccountValue as number) - (value30d as number)
                : null;
        const daysSinceInception = Math.max(
            1,
            Math.floor((now - LAUNCH_DATE_MS) / MS_PER_DAY)
        );
        const fromBooks = ourBooks
            ? await pnlPctFromBooks(
                  ourBooks,
                  vaultEquityUsd,
                  Number.isFinite(positions.totalCapitalUsd)
                      ? (positions.totalCapitalUsd as number)
                      : null,
                  now
              )
            : null;
        const pnlChange30dPct =
            fromBooks?.[30] ??
            calcPnlPct(updates, MIN_POSITION_USD, 30, positions.positions);
        const pnlChange60dPct =
            fromBooks?.[60] ??
            calcPnlPct(updates, MIN_POSITION_USD, 60, positions.positions);
        const pnlChangeInceptionPct =
            fromBooks?.inception ??
            calcPnlPct(
                updates,
                MIN_POSITION_USD,
                daysSinceInception,
                positions.positions
            );
        const maxDrawdownFromOurSeries = await readMaxDrawdownFromSeries(LAUNCH_DATE_MS).catch(
            () => null
        );
        const maxDrawdownPct =
            maxDrawdownFromOurSeries ??
            (await calcProRataMaxDrawdownPct(vaults.items, updates, MIN_POSITION_USD));
        const winRatePct =
            winRateBooks && winRateBooks.totalClosures > 0
                ? (winRateBooks.wins / winRateBooks.totalClosures) * 100
                : calcWinRatePct(updates, LAUNCH_DATE_MS, MIN_POSITION_USD);

        // Total capital = HL accountEquity (perps wallet + vault equities).
        // Withdrawn-but-not-yet-redeployed cash sits in the wallet between
        // rounds, so vault-only TVL yo-yos on every exit while total capital
        // stays smooth — the UI headline should show total capital and break
        // out the pending slice.
        const totalCapitalUsd = Number.isFinite(positions.totalCapitalUsd)
            ? (positions.totalCapitalUsd as number)
            : null;
        const pendingDeployUsd =
            totalCapitalUsd !== null && vaultEquityUsd !== null
                ? Math.max(0, totalCapitalUsd - vaultEquityUsd)
                : null;

        return {
            userAddress: wallet,
            tvlUsd: tvlUsd !== null ? round(tvlUsd, 6) : null,
            totalCapitalUsd:
                totalCapitalUsd !== null ? round(totalCapitalUsd, 6) : null,
            pendingDeployUsd:
                pendingDeployUsd !== null ? round(pendingDeployUsd, 6) : null,
            tvlChange30dUsd:
                tvlChange30dUsd !== null ? round(tvlChange30dUsd, 6) : null,
            pnlChange30dPct:
                pnlChange30dPct !== null ? round(pnlChange30dPct, 4) : null,
            pnlChange60dPct:
                pnlChange60dPct !== null ? round(pnlChange60dPct, 4) : null,
            pnlChangeInceptionPct:
                pnlChangeInceptionPct !== null ? round(pnlChangeInceptionPct, 4) : null,
            daysSinceInception,
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

    static async resolveVaultNames(
        vaults: string[]
    ): Promise<Map<string, string>> {
        return fetchVaultNames(vaults);
    }
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
        a.requirePositiveAllTimePnl === b.requirePositiveAllTimePnl &&
        a.maxDrawdownPct === b.maxDrawdownPct &&
        a.maxMarginUtilPct === b.maxMarginUtilPct &&
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

    if (!highRecs.length) {
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

async function calcProRataMaxDrawdownPct(
    vaultEntries: UserVaultEntry[],
    updates: UserLedgerUpdate[],
    minUsd: number
): Promise<number | null> {
    let totalWeight = 0;
    let weightedDrawdown = 0;
    let count = 0;

    // 1. Active vaults — use per-user account value history, weight by equity
    const activeAddresses = new Set<string>();
    for (const entry of vaultEntries) {
        const equity = Number.isFinite(entry.equity) ? entry.equity : 0;
        if (equity < minUsd) continue;
        activeAddresses.add(entry.vaultAddress.toLowerCase());
        const points = normalizeSeries(
            entry.userHistory?.accountValue?.points
        );
        if (points.length < 2) continue;
        const dd = calcVaultMaxDrawdownPct(points);
        weightedDrawdown += dd * equity;
        totalWeight += equity;
        count++;
    }

    // 2. Closed vaults in last 30 days — fetch vault-level history,
    //    filter to investment period, weight by basis
    const cutoff = Date.now() - 30 * MS_PER_DAY;
    const closedWithdraws = updates.filter((entry) => {
        if (entry.type !== "vaultWithdraw") return false;
        if (!Number.isFinite(entry.time) || entry.time < cutoff) return false;
        if (Math.abs(entry.usdc) < minUsd) return false;
        if (!Number.isFinite(entry.basisUsd) || (entry.basisUsd as number) <= 0) return false;
        return !activeAddresses.has(entry.vault.toLowerCase());
    });

    // Find matching deposit time for each closed vault
    const depositsByVault = new Map<string, number>();
    for (const u of updates) {
        if (u.type !== "vaultDeposit") continue;
        const key = u.vault.toLowerCase();
        const existing = depositsByVault.get(key);
        if (!existing || u.time < existing) {
            depositsByVault.set(key, u.time);
        }
    }

    // Fetch vault details and compute drawdown for each closed vault
    const closedResults = await mapWithConcurrency(
        closedWithdraws,
        3,
        async (withdraw) => {
            const vaultAddr = withdraw.vault;
            const depositTime = depositsByVault.get(vaultAddr.toLowerCase());
            if (!Number.isFinite(depositTime)) return null;
            const history = await HyperliquidConnector.getVaultHistory(vaultAddr);
            if (!history?.accountValue?.points) return null;
            const allPoints = normalizeSeries(history.accountValue.points);
            const filtered = allPoints.filter(
                (p) => p.timestamp >= (depositTime as number) && p.timestamp <= withdraw.time
            );
            if (filtered.length < 2) return null;
            return {
                dd: calcVaultMaxDrawdownPct(filtered),
                weight: withdraw.basisUsd as number,
            };
        }
    );

    for (const result of closedResults) {
        if (!result) continue;
        weightedDrawdown += result.dd * result.weight;
        totalWeight += result.weight;
        count++;
    }

    if (!count || totalWeight <= 0) return null;
    return toSignedDrawdownPct(weightedDrawdown / totalWeight);
}

/**
 * New PnL% calc, sourced from our FIFO books (`position_account`) and the
 * mirrored portfolio time series (`portfolio_series`).
 *
 * Inception:
 *   total_pnl_now = realized_total + (vault_equity - basis_open_total)
 *   implied_seed  = max(wallet_value_now - total_pnl_now, basis_open_total)
 *   pct           = total_pnl_now / implied_seed * 100
 *
 * Wallet-growth denominator (= wallet now − total PnL = implied starting
 * capital) is stable across rebalances. Falls back to basis_open_total when
 * wallet value isn't available or the math goes nonsensical.
 *
 * Windowed (30d / 60d):
 *   total_pnl_at_t      = our_realized_at_t + (vault_equity_at_t - our_basis_at_t)
 *   denominator         = our_basis_at_t  (capital at risk at start of window)
 *   pct                 = (total_pnl_now - total_pnl_at_t) / denominator * 100
 *
 * `vaultEquityUsd` must be the sum of open vault equities (NOT HL's
 * portfolio.accountValue, which is the perp wallet) — otherwise rebalances
 * that move cash perp↔vault show up as spurious PnL swings.
 */
async function pnlPctFromBooks(
    books: PositionAccountAggregate,
    vaultEquityUsd: number | null,
    walletValueUsd: number | null,
    nowMs: number
): Promise<{ 30: number | null; 60: number | null; inception: number | null } | null> {
    const inception = calcInceptionPnlPct(
        books.realizedPnlTotal,
        books.basisOpenTotal,
        vaultEquityUsd,
        walletValueUsd
    );
    if (!inception) return null;
    const { totalPnlNow, inceptionPct } = inception;
    const windowPct = async (days: number): Promise<number | null> => {
        const targetMs = nowMs - days * MS_PER_DAY;
        const snap = await readPortfolioSnapshotAt(targetMs).catch(() => null);
        if (!snap || snap.ourBasisUsdOpen == null || snap.ourBasisUsdOpen <= 0) {
            return null;
        }
        // Prefer vault_equity (vault-only) over HL accountValue (which is the
        // perp wallet) — see comment in pnlPctFromBooks for why.
        const startEquity = snap.vaultEquityUsd ?? snap.accountValueUsd ?? null;
        const startUnrealized =
            startEquity != null ? startEquity - (snap.ourBasisUsdOpen ?? 0) : 0;
        const startTotalPnl = (snap.ourRealizedPnlUsd ?? 0) + startUnrealized;
        return ((totalPnlNow - startTotalPnl) / snap.ourBasisUsdOpen) * 100;
    };
    const [p30, p60] = await Promise.all([windowPct(30), windowPct(60)]);
    return { 30: p30, 60: p60, inception: inceptionPct };
}

