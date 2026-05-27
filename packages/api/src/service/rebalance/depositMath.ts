// Pure deposit-planning math. Kept isolated from DepositService so unit tests
// don't drag in the Hyperliquid SDK transitively via HyperliquidConnector.

import type { VaultRecommendation } from "../vaults/types";

export type DepositTargetCore = {
    vaultAddress: `0x${string}`;
    name: string;
    confidence: "high" | "low";
    kind: "new";
    targetPct: number;
    targetUsd: number;
    currentUsd: number;
    desiredUsd: number;
    depositUsd: number;
};

export function buildTargetFromAllocation(
    rec: VaultRecommendation,
    confidence: "high" | "low",
    groupAllocationUsd: number,
    groupCount: number
): DepositTargetCore {
    const perVaultUsd = groupCount > 0 ? groupAllocationUsd / groupCount : 0;
    const depositUsd = floorUsd(perVaultUsd);
    const targetPct = groupCount > 0 ? 100 / groupCount : 0;
    return {
        vaultAddress: rec.vaultAddress as `0x${string}`,
        name: rec.name,
        confidence,
        kind: "new",
        targetPct,
        targetUsd: depositUsd,
        currentUsd: 0,
        desiredUsd: depositUsd,
        depositUsd,
    };
}

export function normalizeGroupPcts(
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

export function clampCount(value: number, min: number, max?: number): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return min;
    const upper = max ?? Number.POSITIVE_INFINITY;
    return Math.min(upper, Math.max(min, Math.floor(num)));
}

export function roundPct(value: number): number {
    return Math.round(value * 100) / 100;
}

export function roundUsd(value: number): number {
    return Math.round(value * 100) / 100;
}

// Floor to cent for deposit sizes — rounding up can produce a per-target sum
// that exceeds availableForDeposit and causes the last deposit to fail with
// "Insufficient funds available to deposit."
export function floorUsd(value: number): number {
    return Math.floor(value * 100) / 100;
}
