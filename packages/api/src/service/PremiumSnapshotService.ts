import { VaultService } from "./vaults/VaultService";
import { VaultContractService } from "./settlement/VaultContractService";
import { MarketDataService } from "./claude/MarketDataService";
import { RebalanceOrchestrator } from "./rebalance/RebalanceOrchestrator";
import { logger } from "./utils/logger";

/**
 * Premium endpoint payload — assembled from already-cached upstream services.
 * Cached for 5 min so that a burst of paid requests does not amplify upstream
 * load (Hyperliquid API, CoinGecko, RPC) or trigger any Claude calls.
 *
 * IMPORTANT: this payload is shaped to be useful to a buyer without leaking
 * our internal scoring logic, allocation maths, confidence bucketing, or
 * Claude rationale. Top picks are exposed as ordered names + addresses only.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;

interface PremiumPayload {
    fund: {
        name: string;
        contract: string | undefined;
        chain: string;
        epoch: number;
        sharePrice: number;
        tvlUsd: number;
        deployedToL1: number;
        idleUsdc: number;
        pendingDepositsUsd: number;
        pendingWithdrawsShares: number;
    };
    currentAllocations: Array<{
        vault: string;
        vaultAddress: string;
        allocationUsd: number | null;
        allocationPct: number | null;
        pnlUsd: number | null;
        roePct: number | null;
    }>;
    marketSentiment: {
        trend: string;
        preferredDirection: string;
        btc24hChangePct: number | null;
        btc7dChangePct: number | null;
        eth24hChangePct: number | null;
        eth7dChangePct: number | null;
        fearGreed: number | null;
        fundingBtc: number | null;
        fundingEth: number | null;
        longShortRatio: number | null;
        btcOpenInterest24hChangePct: number | null;
        ethOpenInterest24hChangePct: number | null;
    };
    candidates: Array<{
        name: string;
        vaultAddress: string;
        tvlUsd: number;
        ageDays: number;
        weeklyPnlPct: number | null;
        monthlyPnlPct: number | null;
        allTimePnlPct: number | null;
        followers: number | null;
        tradesLast7d: number | null;
    }>;
    candidateCount: number;
    topPicks: Array<{
        rank: number;
        name: string;
        vaultAddress: string;
    }>;
    topPicksGeneratedAt: string | null;
    updatedAt: string;
}

interface CacheEntry {
    fetchedAt: number;
    payload: PremiumPayload;
}

export class PremiumSnapshotService {
    private static cache: CacheEntry | null = null;
    private static inFlight: Promise<PremiumPayload> | null = null;

    static async get(): Promise<PremiumPayload> {
        const now = Date.now();
        if (this.cache && now - this.cache.fetchedAt < CACHE_TTL_MS) {
            return this.cache.payload;
        }
        if (this.inFlight) return this.inFlight;

        this.inFlight = this.build()
            .then((payload) => {
                this.cache = { fetchedAt: Date.now(), payload };
                return payload;
            })
            .finally(() => {
                this.inFlight = null;
            });

        return this.inFlight;
    }

    private static async build(): Promise<PremiumPayload> {
        // All upstream calls use their own caches (Vault candidates 5min,
        // positions ~2min, market overlay 60s). No refresh: true anywhere.
        const [positions, contractState, market, candidatesResult] = await Promise.all([
            VaultService.getPlatformPositions(),
            VaultContractService.getContractState(),
            MarketDataService.getMarketOverlay().catch((err) => {
                logger.warn("Premium: market overlay fetch failed", { msg: err?.message });
                return null;
            }),
            VaultService.getCandidates().catch((err) => {
                logger.warn("Premium: candidates fetch failed", { msg: err?.message });
                return null;
            }),
        ]);

        const currentAllocations = positions.positions
            .filter((p) => (p.amountUsd ?? 0) > 1)
            .sort((a, b) => (b.amountUsd ?? 0) - (a.amountUsd ?? 0))
            .map((p) => ({
                vault: p.vaultName ?? p.vaultAddress,
                vaultAddress: p.vaultAddress,
                allocationUsd: p.amountUsd,
                allocationPct: p.sizePct,
                pnlUsd: p.pnlUsd,
                roePct: p.roePct,
            }));

        const candidates = (candidatesResult?.items ?? []).map((c) => ({
            name: c.name,
            vaultAddress: c.vaultAddress,
            tvlUsd: c.tvl,
            ageDays: c.ageDays,
            weeklyPnlPct: c.weeklyPnl,
            monthlyPnlPct: c.monthlyPnl,
            allTimePnlPct: c.allTimePnl,
            followers: c.followers,
            tradesLast7d: c.tradesLast7d,
        }));

        // Top picks — pulled from the most recent rebalance round's Claude output.
        // We expose ORDERED rank + name + address only. We deliberately do NOT
        // expose: confidence buckets, allocation %, scores, reasons, or which
        // are high vs low. Those are internal logic.
        const latest = RebalanceOrchestrator.getLatestRecommendations();
        const topPicks: Array<{ rank: number; name: string; vaultAddress: string }> = [];
        if (latest?.recommendations) {
            const ordered = [
                ...latest.recommendations.highConfidence,
                ...latest.recommendations.lowConfidence,
            ];
            ordered.forEach((rec, i) => {
                topPicks.push({
                    rank: i + 1,
                    name: rec.name,
                    vaultAddress: rec.vaultAddress,
                });
            });
        }

        return {
            fund: {
                name: "VAULT-4",
                contract: process.env.VAULT4FUND_ADDRESS,
                chain: "HyperEVM (999)",
                epoch: contractState.epoch,
                sharePrice: contractState.sharePrice,
                tvlUsd: contractState.totalAssets,
                deployedToL1: contractState.deployedToL1,
                idleUsdc: contractState.idleUsdc,
                pendingDepositsUsd: contractState.pendingDeposits,
                pendingWithdrawsShares: contractState.pendingWithdraws,
            },
            currentAllocations,
            marketSentiment: {
                trend: market?.trend ?? "unknown",
                preferredDirection: market?.preferred_direction ?? "neutral",
                btc24hChangePct: market?.btc_24h_change ?? null,
                btc7dChangePct: market?.btc_7d_change ?? null,
                eth24hChangePct: market?.eth_24h_change ?? null,
                eth7dChangePct: market?.eth_7d_change ?? null,
                fearGreed: market?.fearGreed ?? null,
                fundingBtc: market?.funding_btc ?? null,
                fundingEth: market?.funding_eth ?? null,
                longShortRatio: market?.long_short_ratio ?? null,
                btcOpenInterest24hChangePct: market?.btc_oi_change_24h ?? null,
                ethOpenInterest24hChangePct: market?.eth_oi_change_24h ?? null,
            },
            candidates,
            candidateCount: candidates.length,
            topPicks,
            topPicksGeneratedAt: latest?.generatedAt ?? null,
            updatedAt: new Date().toISOString(),
        };
    }
}
