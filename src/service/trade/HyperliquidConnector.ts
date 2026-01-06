import * as hl from "@nktkas/hyperliquid";
import axios from "axios";
import dotenv from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import { logger } from "../utils/logger";
import type {
    TimeSeries,
    UserPortfolioSummary,
    UserVaultPerformance,
    UserVaultHistory,
    VaultHistory,
    VaultMetrics,
    WindowKey,
    WindowedMetric,
} from "../vaults/types";

dotenv.config();

const VAULTS_URL =
    process.env.HYPERLIQUID_VAULTS_URL ??
    "https://stats-data.hyperliquid.xyz/Mainnet/vaults";
const HYPERLIQUID_RPC =
    process.env.HYPERLIQUID_RPC ?? "https://rpc.hyperlend.finance";
const HYPERLIQUID_INFO_URL =
    process.env.HYPERLIQUID_INFO_URL ?? "https://api.hyperliquid.xyz/info";
const EXCHANGE_PKEY = process.env.WALLET_PK as `0x${string}` | undefined;

export type VaultRaw = {
    summary: {
        vaultAddress: string;
        name: string;
        tvl: number | string;
        isClosed: boolean;
        createTimeMillis: number;
        [key: string]: any;
    };
    pnls?: any;
    [key: string]: any;
};

export type VaultDetails = {
    vaultAddress?: string;
    name?: string;
    allowDeposits?: boolean;
    followers?: any[];
    portfolio?: [string, { accountValueHistory: [number, string][]; pnlHistory: [number, string][]; vlm: string }][];
    [key: string]: any;
};

export type UserVaultEquity = {
    vaultAddress: string;
    equity: number;
    lockedUntilTimestamp: number;
};

export type VaultPerformance = {
    weeklyPnl: number | null;
    monthlyPnl: number | null;
    allTimePnl: number | null;
    pnls?: any;
};

export class HyperliquidConnector {
    private static publicClient: hl.InfoClient | null = null;
    private static exchangeClient: hl.ExchangeClient | null = null;

    static async getVaults(): Promise<VaultRaw[]> {
        return this.fetchVaultsRaw();
    }

    static async fetchVaultsRaw(): Promise<VaultRaw[]> {
        try {
            const response = await axios.get(VAULTS_URL, { timeout: 15000 });
            if (!Array.isArray(response.data)) {
                logger.warn("Unexpected vaults payload from Hyperliquid", {
                    type: typeof response.data,
                });
                return [];
            }
            return response.data;
        } catch (error: any) {
            logger.error("Failed to fetch Hyperliquid vaults", {
                message: error?.message,
            });
            return [];
        }
    }

    static parsePerformance(vault: VaultRaw): VaultPerformance {
        return {
            weeklyPnl: this.getLatestPnl(vault, 1),
            monthlyPnl: this.getLatestPnl(vault, 2),
            allTimePnl: this.getLatestPnl(vault, 0),
            pnls: vault.pnls,
        };
    }

    static async getVaultPerformance(
        vaultAddress: string
    ): Promise<VaultPerformance | null> {
        const vaults = await this.fetchVaultsRaw();
        const match = vaults.find(
            (vault) =>
                vault?.summary?.vaultAddress?.toLowerCase() ===
                vaultAddress.toLowerCase()
        );
        if (!match) return null;
        return this.parsePerformance(match);
    }

    static async getVaultMetrics(vaultAddress: string): Promise<VaultMetrics | null> {
        const details = await this.getVaultDetails(vaultAddress);
        const metricsFromDetails = details
            ? buildMetricsFromDetails(details, vaultAddress)
            : null;
        if (metricsFromDetails) return metricsFromDetails;

        const vault = await this.getVaultByAddress(vaultAddress);
        if (!vault) return null;

        const pnlFromPnls: WindowedMetric = {
            "24h": null,
            "7d": this.getLatestPnl(vault, 1),
            "30d": this.getLatestPnl(vault, 2),
            allTime: this.getLatestPnl(vault, 0),
        };
        const pnlFromSummary = windowedFromPaths(vault, PNL_PATHS);
        const pnlSeries = this.extractPnlSeries(vault);
        const pnlFromSeries = windowedFromSeries(pnlSeries, "delta", "last");
        const pnl = mergeWindowed(
            pnlFromSummary,
            mergeWindowed(pnlFromPnls, pnlFromSeries)
        );

        const volumeFromSummary = windowedFromPaths(vault, VOLUME_PATHS);
        const volumeSeries = this.extractSeriesByPaths(vault, VOLUME_SERIES_PATHS);
        const volumeFromSeries = windowedFromSeries(volumeSeries, "delta", "last");
        const volume = mergeWindowed(volumeFromSummary, volumeFromSeries);

        const perpsSeries =
            this.extractSeriesByPaths(vault, PERPS_EQUITY_SERIES_PATHS) ??
            this.extractSeriesByPaths(vault, ACCOUNT_VALUE_SERIES_PATHS);
        const vaultEquitySeries =
            this.extractSeriesByPaths(vault, VAULT_EQUITY_SERIES_PATHS) ??
            this.extractSeriesByPaths(vault, ACCOUNT_VALUE_SERIES_PATHS);

        const perpsFromSummary = windowedFromPaths(vault, PERPS_EQUITY_PATHS);
        const perpsFromSeries = windowedFromSeries(perpsSeries, "last");
        const perpsAccountEquity = mergeWindowed(perpsFromSummary, perpsFromSeries);

        const vaultEquityFromSummary = windowedFromPaths(vault, VAULT_EQUITY_PATHS);
        const vaultEquityFromSeries = windowedFromSeries(vaultEquitySeries, "last");
        const vaultEquity = mergeWindowed(vaultEquityFromSummary, vaultEquityFromSeries);

        const drawdownSeries =
            this.extractSeriesByPaths(vault, ACCOUNT_VALUE_SERIES_PATHS) ??
            pnlSeries;
        const maxDrawdownFromSummary = windowedFromPaths(vault, MAX_DRAWDOWN_PATHS);
        const maxDrawdownFromSeries = windowedMaxDrawdown(drawdownSeries);
        const maxDrawdown = mergeWindowed(maxDrawdownFromSummary, maxDrawdownFromSeries);

        return {
            vaultAddress: vault.summary?.vaultAddress ?? vaultAddress,
            name: vault.summary?.name,
            pnl,
            volume,
            maxDrawdown,
            perpsAccountEquity,
            vaultEquity,
        };
    }

    static async getVaultHistory(vaultAddress: string): Promise<VaultHistory | null> {
        const details = await this.getVaultDetails(vaultAddress);
        const historyFromDetails = details
            ? buildHistoryFromDetails(details, vaultAddress)
            : null;
        if (historyFromDetails) return historyFromDetails;

        const vault = await this.getVaultByAddress(vaultAddress);
        if (!vault) return null;

        const pnl = this.extractPnlSeries(vault);
        const accountValue = this.extractSeriesByPaths(
            vault,
            ACCOUNT_VALUE_SERIES_PATHS
        );

        return {
            vaultAddress: vault.summary?.vaultAddress ?? vaultAddress,
            name: vault.summary?.name,
            pnl,
            accountValue,
        };
    }

    static async getVaultByAddress(vaultAddress: string): Promise<VaultRaw | null> {
        const vaults = await this.fetchVaultsRaw();
        return (
            vaults.find(
                (vault) =>
                    vault?.summary?.vaultAddress?.toLowerCase() ===
                    vaultAddress.toLowerCase()
            ) ?? null
        );
    }

    static async getVaultDetails(vaultAddress: string): Promise<VaultDetails | null> {
        try {
            const client = this.getPublicClient();
            return await client.vaultDetails({ vaultAddress });
        } catch (error: any) {
            logger.warn("Failed to fetch vault details", {
                vaultAddress,
                message: error?.message,
            });
            return null;
        }
    }

    static getVaultMetricsFromDetails(
        details: VaultDetails,
        vaultAddress: string
    ): VaultMetrics | null {
        return buildMetricsFromDetails(details, vaultAddress);
    }

    static getUserVaultPerformance(
        details: VaultDetails,
        userAddress: string
    ): UserVaultPerformance | null {
        return buildUserVaultPerformance(details, userAddress);
    }

    static async getUserVaultEquities(
        userAddress: `0x${string}`
    ): Promise<UserVaultEquity[]> {
        try {
            const client = this.getPublicClient();
            const equities = await client.userVaultEquities({ user: userAddress });
            if (!Array.isArray(equities)) return [];
            return equities.map((entry) => ({
                vaultAddress: entry.vaultAddress,
                equity: Number.isFinite(Number(entry.equity))
                    ? Number(entry.equity)
                    : 0,
                lockedUntilTimestamp: Number.isFinite(Number(entry.lockedUntilTimestamp))
                    ? Number(entry.lockedUntilTimestamp)
                    : 0,
            }));
        } catch (error: any) {
            logger.warn("Failed to fetch user vault equities", {
                userAddress,
                message: error?.message,
            });
            return [];
        }
    }

    static async getUserPortfolioSummary(
        userAddress: `0x${string}`
    ): Promise<UserPortfolioSummary | null> {
        try {
            const client = this.getPublicClient();
            const portfolio = await client.portfolio({ user: userAddress });
            if (!Array.isArray(portfolio)) return null;
            return buildUserPortfolioSummary(userAddress, portfolio);
        } catch (error: any) {
            logger.warn("Failed to fetch user portfolio", {
                userAddress,
                message: error?.message,
            });
            return null;
        }
    }

    static async getUserVaultHistory(
        userAddress: `0x${string}`,
        vaultAddress: `0x${string}`
    ): Promise<UserVaultHistory | null> {
        const details = await this.getVaultDetails(vaultAddress);
        if (!details) return null;
        return buildUserVaultHistory(details, userAddress);
    }

    static getUserVaultHistoryFromDetails(
        details: VaultDetails,
        userAddress: `0x${string}`
    ): UserVaultHistory | null {
        return buildUserVaultHistory(details, userAddress);
    }

    static async getVaultTradesCount(
        vaultAddress: string,
        lookbackDays: number
    ): Promise<number | null> {
        try {
            const client = this.getPublicClient();
            const startTime = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
            const trades = await client.userFillsByTime({
                user: vaultAddress,
                startTime,
            });
            return Array.isArray(trades) ? trades.length : null;
        } catch (error: any) {
            logger.warn("Failed to fetch vault trades", {
                vaultAddress,
                message: error?.message,
            });
            return null;
        }
    }

    static async getVaultTrades(
        vaultAddress: string,
        lookbackDays: number,
        maxTrades?: number
    ): Promise<{ time: number; dir: string; closedPnl: number; fee: number }[]> {
        try {
            const client = this.getPublicClient();
            const startTime = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
            const trades = await client.userFillsByTime({
                user: vaultAddress,
                startTime,
            });
            if (!Array.isArray(trades) || !trades.length) return [];
            const mapped = trades
                .map((trade) => ({
                    time: toNumberSafe(trade.time),
                    dir: typeof trade.dir === "string" ? trade.dir : "",
                    closedPnl: toNumberSafe(trade.closedPnl),
                    fee: toNumberSafe(trade.fee),
                }))
                .filter((trade) => Number.isFinite(trade.time));
            mapped.sort((a, b) => b.time - a.time);
            if (Number.isFinite(Number(maxTrades)) && Number(maxTrades) > 0) {
                return mapped.slice(0, Number(maxTrades));
            }
            return mapped;
        } catch (error: any) {
            logger.warn("Failed to fetch vault trades", {
                vaultAddress,
                message: error?.message,
            });
            return [];
        }
    }

    static async getVaultAccountSummary(
        vaultAddress: string
    ): Promise<{ assetPositions: any[] } | null> {
        try {
            const response = await axios.post(HYPERLIQUID_INFO_URL, {
                type: "userState",
                user: vaultAddress,
            });
            const data = response?.data;
            if (!data || !Array.isArray(data.assetPositions)) {
                return { assetPositions: [] };
            }
            return { assetPositions: data.assetPositions };
        } catch (error: any) {
            logger.warn("Failed to fetch vault account summary", {
                vaultAddress,
                message: error?.message,
            });
            return null;
        }
    }

    static getPublicClient(): hl.InfoClient {
        if (!this.publicClient) {
            const transport = new hl.HttpTransport({
                timeout: null,
                server: {
                    mainnet: {
                        rpc: HYPERLIQUID_RPC,
                    },
                },
            });
            this.publicClient = new hl.InfoClient({ transport });
        }
        return this.publicClient;
    }

    static getExchangeClient(defaultVaultAddress?: `0x${string}`): hl.ExchangeClient {
        if (defaultVaultAddress) {
            const transport = new hl.HttpTransport({
                timeout: null,
                server: {
                    mainnet: {
                        rpc: HYPERLIQUID_RPC,
                    },
                },
            });
            const account = this.getExchangeAccount();
            return new hl.ExchangeClient({
                wallet: account,
                transport,
                defaultVaultAddress,
            });
        }
        if (!this.exchangeClient) {
            const transport = new hl.HttpTransport({
                timeout: null,
                server: {
                    mainnet: {
                        rpc: HYPERLIQUID_RPC,
                    },
                },
            });
            const account = this.getExchangeAccount();
            this.exchangeClient = new hl.ExchangeClient({ wallet: account, transport });
        }
        return this.exchangeClient;
    }

    static async vaultTransfer(
        vaultAddress: `0x${string}`,
        isDeposit: boolean,
        usdMicros: number
    ): Promise<any> {
        const client = this.getExchangeClient();
        return client.vaultTransfer({
            vaultAddress,
            isDeposit,
            usd: usdMicros,
        });
    }

    private static getExchangeAccount() {
        if (!EXCHANGE_PKEY) {
            throw new Error("WALLET_PK is not set");
        }
        return privateKeyToAccount(EXCHANGE_PKEY);
    }

    private static getLatestPnl(vault: VaultRaw, index: number): number | null {
        const series = vault?.pnls?.[index];
        if (!Array.isArray(series)) return null;
        const maybeValues = Array.isArray(series[1]) ? series[1] : series;
        const values = Array.isArray(maybeValues?.[1]) ? maybeValues[1] : maybeValues;
        if (!Array.isArray(values) || values.length === 0) return null;
        const last = values[values.length - 1];
        const num = Number(last);
        return Number.isFinite(num) ? num : null;
    }

    private static extractPnlSeries(vault: VaultRaw): TimeSeries | null {
        const pnls = vault?.pnls;
        if (Array.isArray(pnls)) {
            for (const entry of pnls) {
                const series = parseSeries(entry);
                if (series) return series;
            }
            const fallback = parseSeries(pnls);
            if (fallback) return fallback;
        }
        return this.extractSeriesByPaths(vault, PNL_SERIES_PATHS);
    }

    private static extractSeriesByPaths(
        vault: VaultRaw,
        paths: string[]
    ): TimeSeries | null {
        for (const path of paths) {
            const value = getByPath(vault, path);
            const series = parseSeries(value);
            if (series) return series;
        }
        return null;
    }
}

type PortfolioEntry = {
    accountValueHistory?: [number, string][];
    pnlHistory?: [number, string][];
    vlm?: string;
    [key: string]: any;
};

type PortfolioMap = Record<string, PortfolioEntry>;

const PORTFOLIO_KEYS: Record<WindowKey, string> = {
    "24h": "day",
    "7d": "week",
    "30d": "month",
    allTime: "allTime",
};

const PERP_PORTFOLIO_KEYS: Record<WindowKey, string> = {
    "24h": "perpDay",
    "7d": "perpWeek",
    "30d": "perpMonth",
    allTime: "perpAllTime",
};

function buildMetricsFromDetails(
    details: VaultDetails,
    vaultAddress: string
): VaultMetrics | null {
    if (!Array.isArray(details.portfolio)) return null;
    const portfolio = toPortfolioMap(details.portfolio);

    const pnl = windowedFromPortfolioSeries(portfolio, PORTFOLIO_KEYS, "pnlHistory", "delta");
    const volume = windowedVolumeFromPortfolio(portfolio, PORTFOLIO_KEYS);
    const vaultEquity = windowedFromPortfolioSeries(
        portfolio,
        PORTFOLIO_KEYS,
        "accountValueHistory",
        "last"
    );
    const perpsAccountEquity = windowedFromPortfolioSeries(
        portfolio,
        PERP_PORTFOLIO_KEYS,
        "accountValueHistory",
        "last"
    );
    const maxDrawdown = windowedMaxDrawdownFromPortfolio(portfolio, PORTFOLIO_KEYS);

    return {
        vaultAddress: details.vaultAddress ?? vaultAddress,
        name: details.name,
        pnl,
        volume,
        maxDrawdown,
        perpsAccountEquity,
        vaultEquity,
    };
}

function buildHistoryFromDetails(
    details: VaultDetails,
    vaultAddress: string
): VaultHistory | null {
    if (!Array.isArray(details.portfolio)) return null;
    const portfolio = toPortfolioMap(details.portfolio);
    const entry =
        portfolio[PORTFOLIO_KEYS.allTime] ??
        portfolio[PORTFOLIO_KEYS["30d"]] ??
        portfolio[PORTFOLIO_KEYS["7d"]] ??
        portfolio[PORTFOLIO_KEYS["24h"]];

    const pnl = parseSeries(entry?.pnlHistory);
    const accountValue = parseSeries(entry?.accountValueHistory);
    if (!pnl && !accountValue) return null;

    return {
        vaultAddress: details.vaultAddress ?? vaultAddress,
        name: details.name,
        pnl,
        accountValue,
    };
}

function buildUserVaultPerformance(
    details: VaultDetails,
    userAddress: string
): UserVaultPerformance | null {
    const follower = findFollower(details, userAddress);
    if (!follower) return null;

    const entryTime = toNumberSafe(follower.vaultEntryTime);
    const userHistory = buildUserVaultHistory(details, userAddress, follower);
    const accountSeries = userHistory?.accountValue ?? null;
    const maxDrawdownPct = maxDrawdownFromSeries(accountSeries);
    const pnlWindowed = userHistory?.pnl
        ? windowedFromSeries(userHistory.pnl, "delta", "last")
        : emptyWindowed();
    const accountValueWindowed = userHistory?.accountValue
        ? windowedFromSeries(userHistory.accountValue, "last", "last")
        : emptyWindowed();

    return {
        userAddress,
        vaultAddress: details.vaultAddress ?? "",
        vaultEquity: toNumberSafe(follower.vaultEquity),
        pnl: toNumberSafe(follower.pnl),
        allTimePnl: toNumberSafe(follower.allTimePnl),
        pnlWindowed,
        accountValueWindowed,
        daysFollowing: toNumberSafe(follower.daysFollowing),
        vaultEntryTime: Number.isFinite(entryTime) ? entryTime : null,
        lockupUntil: toNumberSafe(follower.lockupUntil),
        maxDrawdownPct,
    };
}

function findFollower(details: VaultDetails, userAddress: string): any | null {
    const followers = Array.isArray(details.followers) ? details.followers : [];
    return (
        followers.find(
            (entry) =>
                String(entry.user ?? "").toLowerCase() ===
                userAddress.toLowerCase()
        ) ?? null
    );
}

function buildUserVaultHistory(
    details: VaultDetails,
    userAddress: string,
    followerOverride?: any
): UserVaultHistory | null {
    if (!Array.isArray(details.portfolio)) return null;
    const follower = followerOverride ?? findFollower(details, userAddress);
    if (!follower) return null;

    const portfolio = toPortfolioMap(details.portfolio);
    const entry =
        portfolio[PORTFOLIO_KEYS.allTime] ??
        portfolio[PORTFOLIO_KEYS["30d"]] ??
        portfolio[PORTFOLIO_KEYS["7d"]] ??
        portfolio[PORTFOLIO_KEYS["24h"]];
    const totalEquitySeries = parseSeries(entry?.accountValueHistory);
    if (!totalEquitySeries || !totalEquitySeries.points.length) return null;

    const entryTime = toNumberSafe(follower.vaultEntryTime);
    if (!Number.isFinite(entryTime)) return null;

    const userEquity = toNumberSafe(follower.vaultEquity);
    if (!Number.isFinite(userEquity)) return null;

    const entryEquity = findValueAtOrBefore(totalEquitySeries, entryTime);
    if (!Number.isFinite(entryEquity) || entryEquity <= 0) return null;

    const latestEquity = totalEquitySeries.points[totalEquitySeries.points.length - 1]
        .value;
    if (!Number.isFinite(latestEquity) || latestEquity <= 0) return null;

    const shareRatio = userEquity / latestEquity;
    const accountValuePoints = totalEquitySeries.points
        .filter((point) => point.timestamp >= entryTime)
        .map((point) => ({
            timestamp: point.timestamp,
            value: round(point.value * shareRatio, 8),
        }));
    if (!accountValuePoints.length) return null;

    const lastEquity = accountValuePoints[accountValuePoints.length - 1].value;
    const followerPnl = toNumberSafe(follower.pnl);
    const baseEquity = Number.isFinite(followerPnl)
        ? lastEquity - followerPnl
        : accountValuePoints[0].value;
    const pnlPoints = accountValuePoints.map((point) => ({
        timestamp: point.timestamp,
        value: round(point.value - baseEquity, 8),
    }));

    return {
        userAddress,
        vaultAddress: details.vaultAddress ?? "",
        pnl: { points: pnlPoints },
        accountValue: { points: accountValuePoints },
    };
}

function buildUserPortfolioSummary(
    userAddress: string,
    portfolioData: [string, PortfolioEntry][]
): UserPortfolioSummary {
    const portfolio = toPortfolioMap(portfolioData);
    const pnl = windowedFromPortfolioSeries(
        portfolio,
        PORTFOLIO_KEYS,
        "pnlHistory",
        "last"
    );
    const volume = windowedVolumeFromPortfolio(portfolio, PORTFOLIO_KEYS);
    const accountEquity = windowedFromPortfolioSeries(
        portfolio,
        PORTFOLIO_KEYS,
        "accountValueHistory",
        "last"
    );
    const maxDrawdown = windowedMaxDrawdownFromPortfolio(portfolio, PORTFOLIO_KEYS);

    const historyEntry =
        portfolio[PORTFOLIO_KEYS.allTime] ??
        portfolio[PORTFOLIO_KEYS["30d"]] ??
        portfolio[PORTFOLIO_KEYS["7d"]] ??
        portfolio[PORTFOLIO_KEYS["24h"]];
    const history = {
        pnl: parseSeries(historyEntry?.pnlHistory),
        accountValue: parseSeries(historyEntry?.accountValueHistory),
    };

    return {
        userAddress,
        metrics: {
            pnl,
            volume,
            maxDrawdown,
            accountEquity,
        },
        history,
    };
}

function toPortfolioMap(
    portfolio: [string, PortfolioEntry][]
): PortfolioMap {
    const map: PortfolioMap = {};
    for (const entry of portfolio) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [key, value] = entry;
        if (typeof key !== "string") continue;
        map[key] = value ?? {};
    }
    return map;
}

function windowedFromPortfolioSeries(
    portfolio: PortfolioMap,
    keyMap: Record<WindowKey, string>,
    seriesKey: "pnlHistory" | "accountValueHistory",
    mode: "delta" | "last" | "sum"
): WindowedMetric {
    return {
        "24h": seriesMetric(portfolio[keyMap["24h"]], seriesKey, mode),
        "7d": seriesMetric(portfolio[keyMap["7d"]], seriesKey, mode),
        "30d": seriesMetric(portfolio[keyMap["30d"]], seriesKey, mode),
        allTime: seriesMetric(portfolio[keyMap.allTime], seriesKey, mode),
    };
}

function windowedVolumeFromPortfolio(
    portfolio: PortfolioMap,
    keyMap: Record<WindowKey, string>
): WindowedMetric {
    return {
        "24h": parseVolume(portfolio[keyMap["24h"]]),
        "7d": parseVolume(portfolio[keyMap["7d"]]),
        "30d": parseVolume(portfolio[keyMap["30d"]]),
        allTime: parseVolume(portfolio[keyMap.allTime]),
    };
}

function windowedMaxDrawdownFromPortfolio(
    portfolio: PortfolioMap,
    keyMap: Record<WindowKey, string>
): WindowedMetric {
    return {
        "24h": maxDrawdownFromEntry(portfolio[keyMap["24h"]]),
        "7d": maxDrawdownFromEntry(portfolio[keyMap["7d"]]),
        "30d": maxDrawdownFromEntry(portfolio[keyMap["30d"]]),
        allTime: maxDrawdownFromEntry(portfolio[keyMap.allTime]),
    };
}

function maxDrawdownFromEntry(entry?: PortfolioEntry): number | null {
    const series = parseSeries(entry?.accountValueHistory);
    return maxDrawdownFromSeries(series);
}

function seriesMetric(
    entry: PortfolioEntry | undefined,
    seriesKey: "pnlHistory" | "accountValueHistory",
    mode: "delta" | "last" | "sum"
): number | null {
    const series = parseSeries(entry?.[seriesKey]);
    return seriesValue(series, mode);
}

function seriesValue(series: TimeSeries | null, mode: "delta" | "last" | "sum"): number | null {
    if (!series || !series.points.length) return null;
    if (mode === "last") return series.points[series.points.length - 1].value;
    if (mode === "sum") return series.points.reduce((acc, point) => acc + point.value, 0);
    if (series.points.length < 2) return null;
    return series.points[series.points.length - 1].value - series.points[0].value;
}

function parseVolume(entry?: PortfolioEntry): number | null {
    const num = Number(entry?.vlm);
    return Number.isFinite(num) ? num : null;
}

function maxDrawdownFromSeries(series: TimeSeries | null): number | null {
    if (!series || series.points.length < 2) return null;
    let peak = series.points[0].value;
    let maxDd = 0;
    for (const point of series.points) {
        if (point.value > peak) peak = point.value;
        if (peak <= 0) continue;
        const dd = ((peak - point.value) / peak) * 100;
        if (dd > maxDd) maxDd = dd;
    }
    return round(maxDd, 4);
}

const WINDOW_MS: Record<WindowKey, number> = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    allTime: Number.POSITIVE_INFINITY,
};

const PNL_PATHS: Record<WindowKey, string[]> = {
    "24h": [
        "summary.pnl24h",
        "summary.pnl1d",
        "summary.pnlDay",
        "summary.pnlDaily",
    ],
    "7d": [
        "summary.pnl7d",
        "summary.pnl1w",
        "summary.pnlWeek",
        "summary.weeklyPnl",
    ],
    "30d": [
        "summary.pnl30d",
        "summary.pnl1m",
        "summary.pnlMonth",
        "summary.monthlyPnl",
    ],
    allTime: [
        "summary.pnlAllTime",
        "summary.pnlAll",
        "summary.totalPnl",
        "summary.pnl",
    ],
};

const VOLUME_PATHS: Record<WindowKey, string[]> = {
    "24h": [
        "summary.volume24h",
        "summary.volume1d",
        "summary.dailyVolume",
        "summary.dayVolume",
        "summary.vol24h",
    ],
    "7d": [
        "summary.volume7d",
        "summary.volume1w",
        "summary.weeklyVolume",
        "summary.vol7d",
    ],
    "30d": [
        "summary.volume30d",
        "summary.volume1m",
        "summary.monthlyVolume",
        "summary.vol30d",
    ],
    allTime: [
        "summary.volumeAllTime",
        "summary.volumeAll",
        "summary.totalVolume",
        "summary.volume",
    ],
};

const MAX_DRAWDOWN_PATHS: Record<WindowKey, string[]> = {
    "24h": [
        "summary.maxDrawdown24h",
        "summary.maxDrawdown1d",
        "summary.maxDd24h",
    ],
    "7d": [
        "summary.maxDrawdown7d",
        "summary.maxDrawdown1w",
        "summary.maxDd7d",
    ],
    "30d": [
        "summary.maxDrawdown30d",
        "summary.maxDrawdown1m",
        "summary.maxDd30d",
    ],
    allTime: [
        "summary.maxDrawdownAllTime",
        "summary.maxDrawdown",
        "summary.maxDd",
    ],
};

const PERPS_EQUITY_PATHS: Record<WindowKey, string[]> = {
    "24h": [
        "summary.perpsAccountEquity24h",
        "summary.perpsAccountValue24h",
        "summary.accountValue24h",
    ],
    "7d": [
        "summary.perpsAccountEquity7d",
        "summary.perpsAccountValue7d",
        "summary.accountValue7d",
    ],
    "30d": [
        "summary.perpsAccountEquity30d",
        "summary.perpsAccountValue30d",
        "summary.accountValue30d",
    ],
    allTime: [
        "summary.perpsAccountEquity",
        "summary.perpsAccountValue",
        "summary.accountValue",
        "summary.accountEquity",
    ],
};

const VAULT_EQUITY_PATHS: Record<WindowKey, string[]> = {
    "24h": ["summary.vaultEquity24h", "summary.equity24h"],
    "7d": ["summary.vaultEquity7d", "summary.equity7d"],
    "30d": ["summary.vaultEquity30d", "summary.equity30d"],
    allTime: ["summary.vaultEquity", "summary.equity", "summary.tvl"],
};

const PNL_SERIES_PATHS = ["pnlHistory", "summary.pnlHistory"];
const VOLUME_SERIES_PATHS = [
    "volumeHistory",
    "summary.volumeHistory",
    "volumeSeries",
    "summary.volumeSeries",
];
const ACCOUNT_VALUE_SERIES_PATHS = [
    "accountValueHistory",
    "summary.accountValueHistory",
    "accountValueSeries",
    "summary.accountValueSeries",
    "accountValues",
    "summary.accountValues",
    "equityHistory",
    "summary.equityHistory",
];
const PERPS_EQUITY_SERIES_PATHS = [
    "perpsAccountEquityHistory",
    "summary.perpsAccountEquityHistory",
    "perpsAccountValueHistory",
    "summary.perpsAccountValueHistory",
];
const VAULT_EQUITY_SERIES_PATHS = [
    "vaultEquityHistory",
    "summary.vaultEquityHistory",
    "tvlHistory",
    "summary.tvlHistory",
];

function windowedFromPaths(root: any, paths: Record<WindowKey, string[]>): WindowedMetric {
    return {
        "24h": readNumberByPaths(root, paths["24h"]),
        "7d": readNumberByPaths(root, paths["7d"]),
        "30d": readNumberByPaths(root, paths["30d"]),
        allTime: readNumberByPaths(root, paths.allTime),
    };
}

function windowedFromSeries(
    series: TimeSeries | null,
    mode: "delta" | "last" | "sum",
    allTimeMode: "delta" | "last" | "sum" = mode
): WindowedMetric {
    if (!series || !series.points.length) return emptyWindowed();
    const now = Date.now();
    return {
        "24h": aggregateSeries(series, now - WINDOW_MS["24h"], now, mode),
        "7d": aggregateSeries(series, now - WINDOW_MS["7d"], now, mode),
        "30d": aggregateSeries(series, now - WINDOW_MS["30d"], now, mode),
        allTime: aggregateSeries(series, 0, now, allTimeMode),
    };
}

function windowedMaxDrawdown(series: TimeSeries | null): WindowedMetric {
    if (!series || !series.points.length) return emptyWindowed();
    const now = Date.now();
    return {
        "24h": maxDrawdown(series, now - WINDOW_MS["24h"], now),
        "7d": maxDrawdown(series, now - WINDOW_MS["7d"], now),
        "30d": maxDrawdown(series, now - WINDOW_MS["30d"], now),
        allTime: maxDrawdown(series, 0, now),
    };
}

function mergeWindowed(primary: WindowedMetric, fallback: WindowedMetric): WindowedMetric {
    return {
        "24h": primary["24h"] ?? fallback["24h"],
        "7d": primary["7d"] ?? fallback["7d"],
        "30d": primary["30d"] ?? fallback["30d"],
        allTime: primary.allTime ?? fallback.allTime,
    };
}

function emptyWindowed(): WindowedMetric {
    return { "24h": null, "7d": null, "30d": null, allTime: null };
}

function readNumberByPaths(root: any, paths: string[]): number | null {
    for (const path of paths) {
        const value = getByPath(root, path);
        const num = Number(value);
        if (Number.isFinite(num)) return num;
    }
    return null;
}

function aggregateSeries(
    series: TimeSeries,
    start: number,
    end: number,
    mode: "delta" | "last" | "sum"
): number | null {
    const points = sliceSeries(series, start, end);
    if (!points.length) return null;
    if (mode === "last") return points[points.length - 1].value;
    if (mode === "sum") return points.reduce((acc, point) => acc + point.value, 0);
    return points[points.length - 1].value - points[0].value;
}

function maxDrawdown(series: TimeSeries, start: number, end: number): number | null {
    const points = sliceSeries(series, start, end);
    if (points.length < 2) return null;
    let peak = points[0].value;
    let maxDd = 0;
    for (const point of points) {
        if (point.value > peak) peak = point.value;
        if (peak <= 0) continue;
        const dd = ((peak - point.value) / peak) * 100;
        if (dd > maxDd) maxDd = dd;
    }
    return round(maxDd, 4);
}

function sliceSeries(series: TimeSeries, start: number, end: number): TimeSeries["points"] {
    const points = series.points.filter(
        (point) => point.timestamp >= start && point.timestamp <= end
    );
    return points.sort((a, b) => a.timestamp - b.timestamp);
}

function findValueAtOrBefore(series: TimeSeries, timestamp: number): number | null {
    if (!series.points.length) return null;
    let candidate: number | null = null;
    for (const point of series.points) {
        if (point.timestamp > timestamp) break;
        candidate = point.value;
    }
    return candidate ?? series.points[0]?.value ?? null;
}

function parseSeries(raw: any): TimeSeries | null {
    if (!raw) return null;
    if (Array.isArray(raw)) {
        if (!raw.length) return null;
        if (isPair(raw[0])) {
            return buildSeriesFromPairs(raw);
        }
        if (raw.length === 2 && Array.isArray(raw[0]) && Array.isArray(raw[1])) {
            return buildSeriesFromArrays(raw[0], raw[1]);
        }
        if (
            raw.length >= 3 &&
            Array.isArray(raw[1]) &&
            Array.isArray(raw[2]) &&
            !isPair(raw[1]) &&
            !isPair(raw[2])
        ) {
            return buildSeriesFromArrays(raw[1], raw[2]);
        }
        if (
            raw.length >= 2 &&
            Array.isArray(raw[1]) &&
            Array.isArray(raw[1][0]) &&
            Array.isArray(raw[1][1])
        ) {
            return buildSeriesFromArrays(raw[1][0], raw[1][1]);
        }
        return null;
    }
    if (typeof raw === "object") {
        if (Array.isArray(raw.points)) return buildSeriesFromPairs(raw.points);
        if (Array.isArray(raw.timestamps) && Array.isArray(raw.values)) {
            return buildSeriesFromArrays(raw.timestamps, raw.values);
        }
        if (Array.isArray(raw.t) && Array.isArray(raw.v)) {
            return buildSeriesFromArrays(raw.t, raw.v);
        }
    }
    return null;
}

function isPair(entry: any): boolean {
    if (!Array.isArray(entry) || entry.length !== 2) return false;
    const first = Number(entry[0]);
    const second = Number(entry[1]);
    return Number.isFinite(first) && Number.isFinite(second);
}

function buildSeriesFromArrays(timestamps: any[], values: any[]): TimeSeries | null {
    if (!Array.isArray(timestamps) || !Array.isArray(values)) return null;
    const points: TimeSeries["points"] = [];
    const count = Math.min(timestamps.length, values.length);
    for (let i = 0; i < count; i += 1) {
        const ts = toTimestamp(timestamps[i]);
        const value = Number(values[i]);
        if (!Number.isFinite(ts) || !Number.isFinite(value)) continue;
        points.push({ timestamp: ts, value });
    }
    if (!points.length) return null;
    points.sort((a, b) => a.timestamp - b.timestamp);
    return { points };
}

function buildSeriesFromPairs(pairs: any[]): TimeSeries | null {
    const points: TimeSeries["points"] = [];
    for (const entry of pairs) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const ts = toTimestamp(entry[0]);
        const value = Number(entry[1]);
        if (!Number.isFinite(ts) || !Number.isFinite(value)) continue;
        points.push({ timestamp: ts, value });
    }
    if (!points.length) return null;
    points.sort((a, b) => a.timestamp - b.timestamp);
    return { points };
}

function toTimestamp(value: any): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return NaN;
    return num < 1e12 ? num * 1000 : num;
}

function toNumberSafe(value: any): number | null {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function getByPath(root: any, path: string): any {
    const parts = path.split(".");
    let current = root;
    for (const part of parts) {
        if (!current || typeof current !== "object") return undefined;
        current = current[part];
    }
    return current;
}

function round(value: number, digits: number): number {
    const factor = Math.pow(10, digits);
    return Math.round(value * factor) / factor;
}
