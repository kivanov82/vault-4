import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import { VaultService } from "../vaults/VaultService";
import type { RecommendationSet, VaultRecommendation } from "../vaults/types";
import { RebalanceService, type VaultTransferAction } from "./RebalanceService";

export type DepositPlanOptions = {
    refreshRecommendations?: boolean;
    refreshCandidates?: boolean;
    maxActive?: number;
    highCount?: number;
    lowCount?: number;
    highTotalPct?: number;
    lowTotalPct?: number;
};

export type DepositTarget = {
    vaultAddress: `0x${string}`;
    name: string;
    confidence: "high" | "low";
    targetPct: number;
    targetUsd: number;
    currentUsd: number;
    desiredUsd: number;
    depositUsd: number;
};

export type DepositPlan = {
    generatedAt: string;
    source: RecommendationSet["source"];
    model?: string;
    sourceWalletAddress: `0x${string}`;
    totalCapitalUsd: number;
    availableBalanceUsd: number;
    currentInvestedUsd: number;
    allocation: {
        maxActive: number;
        highCount: number;
        lowCount: number;
        highTotalPct: number;
        lowTotalPct: number;
    };
    targets: DepositTarget[];
};

export type ExecuteDepositPlanOptions = {
    dryRun?: boolean;
    minDepositUsd?: number;
};

export type ExecuteDepositPlanResult = {
    sourceWalletAddress: `0x${string}`;
    dryRun: boolean;
    total: number;
    submitted: number;
    skipped: number;
    errors: number;
    actions: VaultTransferAction[];
};

const DEFAULT_MAX_ACTIVE = readNumberEnv(process.env.DEPOSIT_ACTIVE_COUNT, 10);
const DEFAULT_HIGH_COUNT = readNumberEnv(process.env.DEPOSIT_HIGH_COUNT, 7);
const DEFAULT_LOW_COUNT = readNumberEnv(process.env.DEPOSIT_LOW_COUNT, 3);
const DEFAULT_HIGH_PCT = readNumberEnv(process.env.DEPOSIT_HIGH_PCT, 80);
const DEFAULT_LOW_PCT = readNumberEnv(process.env.DEPOSIT_LOW_PCT, 20);

export class DepositService {
    static async buildDepositPlan(
        options: DepositPlanOptions = {}
    ): Promise<DepositPlan> {
        const sourceWalletAddress = (process.env.WALLET as `0x${string}`) as `0x${string}`;
        if (!sourceWalletAddress) {
            throw new Error("WALLET is not set");
        }

        const maxActive = clampCount(
            options.maxActive ?? DEFAULT_MAX_ACTIVE,
            1
        );
        const highCount = clampCount(
            options.highCount ?? DEFAULT_HIGH_COUNT,
            0,
            maxActive
        );
        const lowCount = clampCount(
            options.lowCount ?? DEFAULT_LOW_COUNT,
            0,
            maxActive - highCount
        );
        const rawHighPct = options.highTotalPct ?? DEFAULT_HIGH_PCT;
        const rawLowPct = options.lowTotalPct ?? DEFAULT_LOW_PCT;

        const recommendations = await VaultService.getRecommendations({
            refresh: options.refreshRecommendations,
            refreshCandidates: options.refreshCandidates,
        });

        const highSelected = recommendations.highConfidence.slice(0, highCount);
        const lowSelected = recommendations.lowConfidence.slice(0, lowCount);

        const actualHighCount = highSelected.length;
        const actualLowCount = lowSelected.length;
        const { highPct, lowPct } = normalizeGroupPcts(
            rawHighPct,
            rawLowPct,
            actualHighCount,
            actualLowCount
        );

        const perpsBalanceUsd =
            (await getAccountEquity(sourceWalletAddress)) ?? 0;
        const currentEquities =
            await HyperliquidConnector.getUserVaultEquities(sourceWalletAddress);
        const currentEquityMap = new Map(
            currentEquities.map((entry) => [
                entry.vaultAddress.toLowerCase(),
                entry.equity,
            ])
        );
        const currentInvestedUsd = currentEquities.reduce(
            (sum, entry) => sum + (Number.isFinite(entry.equity) ? entry.equity : 0),
            0
        );
        const totalCapitalUsd = perpsBalanceUsd + currentInvestedUsd;

        const targets: DepositTarget[] = [
            ...highSelected.map((rec) =>
                buildTarget(
                    rec,
                    "high",
                    highPct,
                    actualHighCount,
                    totalCapitalUsd,
                    currentEquityMap
                )
            ),
            ...lowSelected.map((rec) =>
                buildTarget(
                    rec,
                    "low",
                    lowPct,
                    actualLowCount,
                    totalCapitalUsd,
                    currentEquityMap
                )
            ),
        ];

        const planned = applyAvailableBalance(
            targets,
            perpsBalanceUsd
        );

        return {
            generatedAt: new Date().toISOString(),
            source: recommendations.source,
            model: recommendations.model,
            sourceWalletAddress,
            totalCapitalUsd,
            availableBalanceUsd: perpsBalanceUsd,
            currentInvestedUsd,
            allocation: {
                maxActive,
                highCount: actualHighCount,
                lowCount: actualLowCount,
                highTotalPct: highPct,
                lowTotalPct: lowPct,
            },
            targets: planned,
        };
    }

    static async executeDepositPlan(
        plan: DepositPlan,
        options: ExecuteDepositPlanOptions = {}
    ): Promise<ExecuteDepositPlanResult> {
        const dryRun = options.dryRun ?? true;
        const minDepositUsd = Math.max(0, options.minDepositUsd ?? 1);

        let submitted = 0;
        let skipped = 0;
        let errors = 0;
        const actions: VaultTransferAction[] = [];

        for (const target of plan.targets) {
            if (target.depositUsd < minDepositUsd) {
                skipped += 1;
                actions.push({
                    vaultAddress: target.vaultAddress,
                    usdMicros: Math.floor(target.depositUsd * 1e6),
                    status: "skipped",
                    reason: "below-minimum",
                });
                continue;
            }
            const result = await RebalanceService.depositToVault({
                vaultAddress: target.vaultAddress,
                amountUsd: target.depositUsd,
                dryRun,
            });
            actions.push(result.action);
            if (result.action.status === "submitted") submitted += 1;
            if (result.action.status === "skipped") skipped += 1;
            if (result.action.status === "error") errors += 1;
        }

        return {
            sourceWalletAddress: plan.sourceWalletAddress,
            dryRun,
            total: plan.targets.length,
            submitted,
            skipped,
            errors,
            actions,
        };
    }
}

function buildTarget(
    rec: VaultRecommendation,
    confidence: "high" | "low",
    groupPct: number,
    groupCount: number,
    totalCapitalUsd: number,
    currentEquityMap: Map<string, number>
): DepositTarget {
    const perVaultPct = groupCount > 0 ? groupPct / groupCount : 0;
    const targetUsd = totalCapitalUsd * (perVaultPct / 100);
    const currentUsd =
        currentEquityMap.get(rec.vaultAddress.toLowerCase()) ?? 0;
    const desiredUsd = Math.max(0, targetUsd - currentUsd);
    return {
        vaultAddress: rec.vaultAddress as `0x${string}`,
        name: rec.name,
        confidence,
        targetPct: perVaultPct,
        targetUsd,
        currentUsd,
        desiredUsd,
        depositUsd: desiredUsd,
    };
}

function applyAvailableBalance(
    targets: DepositTarget[],
    availableBalanceUsd: number
): DepositTarget[] {
    if (availableBalanceUsd <= 0) {
        return targets.map((target) => ({ ...target, depositUsd: 0 }));
    }

    const highTargets = targets.filter((t) => t.confidence === "high");
    const lowTargets = targets.filter((t) => t.confidence === "low");
    const desiredHigh = sumTargets(highTargets);
    const desiredLow = sumTargets(lowTargets);
    const desiredTotal = desiredHigh + desiredLow;

    if (desiredTotal <= availableBalanceUsd) {
        return targets.map((target) => ({
            ...target,
            depositUsd: target.desiredUsd,
        }));
    }

    let remaining = availableBalanceUsd;
    const highAllocation = desiredHigh > 0
        ? Math.min(remaining, desiredHigh)
        : 0;
    remaining = Math.max(0, remaining - highAllocation);
    const lowAllocation = desiredLow > 0
        ? Math.min(remaining, desiredLow)
        : 0;

    const highRatio = desiredHigh > 0 ? highAllocation / desiredHigh : 0;
    const lowRatio = desiredLow > 0 ? lowAllocation / desiredLow : 0;

    return targets.map((target) => {
        const ratio = target.confidence === "high" ? highRatio : lowRatio;
        return {
            ...target,
            depositUsd: roundUsd(target.desiredUsd * ratio),
        };
    });
}

async function getAccountEquity(
    sourceWalletAddress: `0x${string}`
): Promise<number | null> {
    const portfolio = await HyperliquidConnector.getUserPortfolioSummary(
        sourceWalletAddress
    );
    const equity = portfolio?.metrics?.accountEquity;
    if (!equity) return null;
    return (
        pickFirstNumber(equity.allTime) ??
        pickFirstNumber(equity["30d"]) ??
        pickFirstNumber(equity["7d"]) ??
        pickFirstNumber(equity["24h"])
    );
}

function pickFirstNumber(value: number | null | undefined): number | null {
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

function sumTargets(targets: DepositTarget[]): number {
    return targets.reduce(
        (sum, target) => sum + (Number.isFinite(target.desiredUsd) ? target.desiredUsd : 0),
        0
    );
}

function normalizeGroupPcts(
    highPct: number,
    lowPct: number,
    highCount: number,
    lowCount: number
): { highPct: number; lowPct: number } {
    if (highCount === 0 && lowCount === 0) {
        return { highPct: 0, lowPct: 0 };
    }
    if (highCount === 0) {
        return { highPct: 0, lowPct: 100 };
    }
    if (lowCount === 0) {
        return { highPct: 100, lowPct: 0 };
    }
    const total = Number(highPct) + Number(lowPct);
    if (!Number.isFinite(total) || total <= 0) {
        return { highPct: 70, lowPct: 30 };
    }
    const scale = 100 / total;
    return {
        highPct: roundPct(Number(highPct) * scale),
        lowPct: roundPct(Number(lowPct) * scale),
    };
}

function clampCount(value: number, min: number, max?: number): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return min;
    const upper = max ?? Number.POSITIVE_INFINITY;
    return Math.min(upper, Math.max(min, Math.floor(num)));
}

function readNumberEnv(value: any, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function roundPct(value: number): number {
    return Math.round(value * 100) / 100;
}

function roundUsd(value: number): number {
    return Math.round(value * 100) / 100;
}
