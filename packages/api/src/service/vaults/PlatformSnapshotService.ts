import { VaultService } from "./VaultService";
import {
    PlatformHistoryResponse,
    PlatformMetricsResponse,
    UserPortfolioSummary,
    UserPositionsResponse,
} from "./types";
import { logger } from "../utils/logger";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

type PlatformSnapshot = {
    positions: UserPositionsResponse | null;
    portfolio: UserPortfolioSummary | null;
    metrics: PlatformMetricsResponse | null;
    history: PlatformHistoryResponse | null;
    refreshedAt: number;
};

export class PlatformSnapshotService {
    private static snapshot: PlatformSnapshot = {
        positions: null,
        portfolio: null,
        metrics: null,
        history: null,
        refreshedAt: 0,
    };
    private static refreshing: Promise<void> | null = null;
    private static interval: NodeJS.Timeout | null = null;

    static async start(): Promise<void> {
        await this.refresh();
        if (!this.interval) {
            this.interval = setInterval(() => {
                this.refresh().catch((error) => {
                    logger.error("Platform snapshot refresh failed", {
                        message: error?.message,
                    });
                });
            }, REFRESH_INTERVAL_MS);
        }
    }

    static async refresh(): Promise<void> {
        if (this.refreshing) return this.refreshing;
        const startedAt = Date.now();
        this.refreshing = (async () => {
            try {
                const [positions, portfolio, metrics, history] = await Promise.all([
                    VaultService.getPlatformPositions({ refresh: true }).catch((e) => {
                        logger.error("Snapshot positions fetch failed", { message: e?.message });
                        return null;
                    }),
                    VaultService.getPlatformPortfolio({ refresh: true }).catch((e) => {
                        logger.error("Snapshot portfolio fetch failed", { message: e?.message });
                        return null;
                    }),
                    VaultService.getPlatformPerformanceMetrics({ refresh: true }).catch((e) => {
                        logger.error("Snapshot metrics fetch failed", { message: e?.message });
                        return null;
                    }),
                    VaultService.getPlatformHistory({
                        refresh: true,
                        page: 1,
                        pageSize: 100,
                    }).catch((e) => {
                        logger.error("Snapshot history fetch failed", { message: e?.message });
                        return null;
                    }),
                ]);
                this.snapshot = {
                    positions: positions ?? this.snapshot.positions,
                    portfolio: portfolio ?? this.snapshot.portfolio,
                    metrics: metrics ?? this.snapshot.metrics,
                    history: history ?? this.snapshot.history,
                    refreshedAt: Date.now(),
                };
                logger.info("Platform snapshot refreshed", {
                    durationMs: Date.now() - startedAt,
                });
            } finally {
                this.refreshing = null;
            }
        })();
        return this.refreshing;
    }

    static getPositions(): UserPositionsResponse | null {
        return this.snapshot.positions;
    }

    static getPortfolio(): UserPortfolioSummary | null {
        return this.snapshot.portfolio;
    }

    static getMetrics(): PlatformMetricsResponse | null {
        return this.snapshot.metrics;
    }

    static getHistory(page: number, pageSize: number): PlatformHistoryResponse | null {
        const full = this.snapshot.history;
        if (!full) return null;
        const clampedPageSize = Math.max(1, Math.min(100, Math.floor(pageSize) || 15));
        const allEntries = full.entries;
        const total = full.total;
        const totalPages = Math.max(1, Math.ceil(total / clampedPageSize));
        const clampedPage = Math.max(1, Math.min(totalPages, Math.floor(page) || 1));
        const start = (clampedPage - 1) * clampedPageSize;
        const entries = allEntries.slice(start, start + clampedPageSize);
        return {
            userAddress: full.userAddress,
            total,
            page: clampedPage,
            pageSize: clampedPageSize,
            totalPages,
            entries,
        };
    }
}
