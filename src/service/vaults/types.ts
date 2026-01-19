import type { VaultPerformance, VaultRaw } from "../trade/HyperliquidConnector";

export type VaultFilters = {
    minTvl: number;
    minAgeDays: number;
    minFollowers: number;
    minTrades7d: number;
    requirePositiveWeeklyPnl: boolean;
    requirePositiveMonthlyPnl: boolean;
    requireDepositsOpen: boolean;
};

export type VaultCandidate = {
    vaultAddress: string;
    name: string;
    tvl: number;
    ageDays: number;
    isClosed: boolean;
    weeklyPnl: number | null;
    monthlyPnl: number | null;
    allTimePnl: number | null;
    followers: number | null;
    allowDeposits: boolean | null;
    tradesLast7d: number | null;
    performance: VaultPerformance;
    raw: VaultRaw;
};

export type CandidatesResult = {
    generatedAt: string;
    filters: VaultFilters;
    count: number;
    items: VaultCandidate[];
};

export type VaultRecommendation = {
    vaultAddress: string;
    name: string;
    confidence: "high" | "low";
    allocationPct: number;
    reason?: string;
    score?: number;
    metrics: {
        tvl: number;
        weeklyPnl: number | null;
        monthlyPnl: number | null;
        allTimePnl: number | null;
        ageDays: number;
        followers: number | null;
        tradesLast7d: number | null;
    };
};

export type RecommendationSet = {
    generatedAt: string;
    source: "openai" | "heuristic";
    model?: string;
    highConfidence: VaultRecommendation[];
    lowConfidence: VaultRecommendation[];
    candidates: {
        count: number;
        generatedAt: string;
    };
    suggestedAllocations?: SuggestedAllocations;
};

export type SuggestedAllocationTarget = {
    rank: number | null;
    vaultAddress: string;
    confidence: "high" | "low" | null;
    allocationPct: number;
    notes?: string;
};

export type SuggestedAllocations = {
    totalPct: number;
    maxActive: number | null;
    highPct: number | null;
    lowPct: number | null;
    highCount: number | null;
    lowCount: number | null;
    barbellNote?: string;
    targets: SuggestedAllocationTarget[];
};

export type WindowKey = "24h" | "7d" | "30d" | "allTime";

export type WindowedMetric = {
    "24h": number | null;
    "7d": number | null;
    "30d": number | null;
    allTime: number | null;
};

export type TimeSeriesPoint = {
    timestamp: number;
    value: number;
};

export type TimeSeries = {
    points: TimeSeriesPoint[];
};

export type VaultMetrics = {
    vaultAddress: string;
    name?: string;
    pnl: WindowedMetric;
    volume: WindowedMetric;
    maxDrawdown: WindowedMetric;
    perpsAccountEquity: WindowedMetric;
    vaultEquity: WindowedMetric;
};

export type VaultHistory = {
    vaultAddress: string;
    name?: string;
    pnl: TimeSeries | null;
    accountValue: TimeSeries | null;
};

export type UserVaultPerformance = {
    userAddress: string;
    vaultAddress: string;
    vaultEquity: number | null;
    pnl: number | null;
    allTimePnl: number | null;
    pnlWindowed?: WindowedMetric;
    accountValueWindowed?: WindowedMetric;
    daysFollowing: number | null;
    vaultEntryTime: number | null;
    lockupUntil: number | null;
    maxDrawdownPct: number | null;
};

export type UserVaultHistory = {
    userAddress: string;
    vaultAddress: string;
    pnl: TimeSeries | null;
    accountValue: TimeSeries | null;
};

export type UserVaultEntry = {
    vaultAddress: string;
    equity: number;
    lockedUntilTimestamp: number;
    vaultName?: string;
    vaultMetrics?: VaultMetrics | null;
    userPerformance?: UserVaultPerformance | null;
    userHistory?: UserVaultHistory | null;
};

export type UserVaultsResponse = {
    userAddress: string;
    count: number;
    items: UserVaultEntry[];
};

export type UserPosition = {
    vaultAddress: string;
    vaultName?: string;
    sizePct: number | null;
    amountUsd: number | null;
    pnlUsd: number | null;
    roePct: number | null;
};

export type UserPositionsResponse = {
    userAddress: string;
    totalPositions: number;
    totalCapitalUsd: number | null;
    totalInvestedUsd: number | null;
    netPnlUsd: number | null;
    positions: UserPosition[];
};

export type PlatformHistoryEntry = {
    time: number;
    type: "vaultDeposit" | "vaultWithdraw";
    vaultAddress: string;
    vaultName?: string;
    amountUsd: number | null;
    realizedPnlUsd: number | null;
};

export type PlatformHistoryResponse = {
    userAddress: string;
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    entries: PlatformHistoryEntry[];
};

export type PlatformMetricsResponse = {
    userAddress: string;
    tvlUsd: number | null;
    tvlChange30dUsd: number | null;
    pnlChange30dPct: number | null;
    winRatePct: number | null;
    maxDrawdownPct: number | null;
    since: string;
    calculatedAt: string;
};

export type UserPortfolioSummary = {
    userAddress: string;
    metrics: {
        pnl: WindowedMetric;
        volume: WindowedMetric;
        maxDrawdown: WindowedMetric;
        accountEquity: WindowedMetric;
    };
    history: {
        pnl: TimeSeries | null;
        accountValue: TimeSeries | null;
    };
};
