import type { VaultRecommendation } from "../vaults/types";
import type { DepositTarget } from "./DepositService.types";

export type ComputeTopupInput = {
    highSelected: VaultRecommendation[];
    lowSelected: VaultRecommendation[];
    /** lowercased vaultAddress → currentUsd. Dust ($1<) must already be filtered. */
    currentEquityMap: Map<string, number>;
    /** perps wallet + vault equities (what Claude's allocationPct is applied to) */
    totalCapitalUsd: number;
    perpsBalanceUsd: number;
    withdrawReserveUsd: number;
    /** USD already committed by the new-slot pass — subtracted from the topup budget */
    newSlotConsumed: number;
    /** % under target before a topup fires (floored to absolute `minDepositUsd`) */
    tolerancePct: number;
    minDepositUsd: number;
};

export type ComputeTopupResult = {
    targets: DepositTarget[];
    diagnostics: {
        heldRecsCount: number;
        eligibleCount: number;
        skippedBelowTolerance: {
            vaultAddress: string;
            wantDeposit: number;
            tolerance: number;
        }[];
        remainingBudget: number;
        totalWant: number;
        scaleFactor: number;
    };
};

/**
 * Pure: for every still-recommended held vault, decide whether to top it up
 * toward Claude's per-vault target and at what size. Topups share the
 * `perpsBalance − withdrawReserve − newSlotConsumed` budget proportionally
 * to their underweight. Skips anything within `tolerancePct` of target (or
 * within `minDepositUsd`, whichever is larger) and any final size below
 * `minDepositUsd`.
 *
 * Kept free of Hyperliquid / contract / Claude imports so it's unit-testable
 * without dragging the HL ESM connector into Jest's classpath.
 */
export function computeTopupTargets(input: ComputeTopupInput): ComputeTopupResult {
    const {
        highSelected,
        lowSelected,
        currentEquityMap,
        totalCapitalUsd,
        perpsBalanceUsd,
        withdrawReserveUsd,
        newSlotConsumed,
        tolerancePct,
        minDepositUsd,
    } = input;

    const totalPerpsBudget = Math.max(0, perpsBalanceUsd - withdrawReserveUsd);
    const remainingBudget = Math.max(0, totalPerpsBudget - newSlotConsumed);

    const heldRecs: { rec: VaultRecommendation; confidence: "high" | "low" }[] = [];
    for (const rec of highSelected) {
        if (currentEquityMap.has(rec.vaultAddress.toLowerCase())) {
            heldRecs.push({ rec, confidence: "high" });
        }
    }
    for (const rec of lowSelected) {
        if (currentEquityMap.has(rec.vaultAddress.toLowerCase())) {
            heldRecs.push({ rec, confidence: "low" });
        }
    }

    type Candidate = {
        rec: VaultRecommendation;
        confidence: "high" | "low";
        currentUsd: number;
        targetUsd: number;
        wantDeposit: number;
    };
    const eligible: Candidate[] = [];
    const skippedBelowTolerance: ComputeTopupResult["diagnostics"]["skippedBelowTolerance"] = [];
    for (const { rec, confidence } of heldRecs) {
        const addr = rec.vaultAddress.toLowerCase();
        const currentUsd = currentEquityMap.get(addr) ?? 0;
        const pct = Math.max(0, Number(rec.allocationPct) || 0);
        if (pct <= 0) continue;
        const targetUsd = totalCapitalUsd * (pct / 100);
        const wantDeposit = Math.max(0, targetUsd - currentUsd);
        const tolerance = Math.max(
            minDepositUsd,
            currentUsd * (tolerancePct / 100)
        );
        if (wantDeposit < tolerance) {
            skippedBelowTolerance.push({
                vaultAddress: rec.vaultAddress,
                wantDeposit: roundUsd(wantDeposit),
                tolerance: roundUsd(tolerance),
            });
            continue;
        }
        eligible.push({ rec, confidence, currentUsd, targetUsd, wantDeposit });
    }

    const totalWant = eligible.reduce((s, c) => s + c.wantDeposit, 0);
    const scaleFactor = totalWant > 0 ? Math.min(1, remainingBudget / totalWant) : 0;

    const targets: DepositTarget[] = [];
    for (const c of eligible) {
        const depositUsd = floorUsd(c.wantDeposit * scaleFactor);
        if (depositUsd < minDepositUsd) continue;
        targets.push({
            vaultAddress: c.rec.vaultAddress as `0x${string}`,
            name: c.rec.name,
            confidence: c.confidence,
            kind: "topup",
            targetPct: roundPct(Number(c.rec.allocationPct) || 0),
            targetUsd: roundUsd(c.targetUsd),
            currentUsd: roundUsd(c.currentUsd),
            desiredUsd: roundUsd(c.wantDeposit),
            depositUsd,
        });
    }

    return {
        targets,
        diagnostics: {
            heldRecsCount: heldRecs.length,
            eligibleCount: eligible.length,
            skippedBelowTolerance,
            remainingBudget: roundUsd(remainingBudget),
            totalWant: roundUsd(totalWant),
            scaleFactor,
        },
    };
}

function roundPct(value: number): number {
    return Math.round(value * 100) / 100;
}

function roundUsd(value: number): number {
    return Math.round(value * 100) / 100;
}

function floorUsd(value: number): number {
    return Math.floor(value * 100) / 100;
}
