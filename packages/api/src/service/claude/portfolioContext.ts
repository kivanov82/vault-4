import { HyperliquidConnector } from "../trade/HyperliquidConnector";
import {
    readLastDepositTimes,
    readRecentLossExitVaults,
    readVaultHistorySummaries,
    type VaultHistorySummary,
} from "../../db/TraceService";
import { logger } from "../utils/logger";

/**
 * Portfolio context fed to both Claude ranking stages. Historically Claude
 * only received `already_exposed` (bare addresses) — it was never told our
 * per-position ROE or our realized history with a vault, so it kept
 * re-recommending vaults we were deeply underwater on, and those positions
 * then dodged the soft stop-loss through the "recommended + aligned ⇒ hold"
 * branch (see STRATEGY-FORENSICS-2026-06.md §3). This module closes that gap.
 *
 * All DB-derived fields degrade gracefully: when the trace layer is down the
 * context collapses to the old bare-addresses behavior.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DUST_THRESHOLD_USD = 1;

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null || raw === "") return fallback;
    const num = Number(raw);
    return Number.isFinite(num) ? num : fallback;
}

// Must match DepositService's REENTRY_COOLDOWN_DAYS — the prompt tells Claude
// these vaults cannot receive deposits, which is only true if the deposit
// filter uses the same window.
const REENTRY_COOLDOWN_DAYS = envNumber("REENTRY_COOLDOWN_DAYS", 10);

export type CurrentPositionContext = {
    address: string;
    current_usd: number;
    /** ROE vs our own FIFO cost basis, percent. Null when basis is unknown. */
    roe_pct: number | null;
    /** Days since our most recent deposit into the vault. */
    hold_days: number | null;
};

export type VaultHistoryContext = {
    address: string;
    /** How many deposits we have made into this vault, ever. */
    episodes: number;
    /** Total realized PnL across all our closed lots in this vault. */
    realized_pnl_usd: number;
    currently_held: boolean;
};

export type PortfolioContext = {
    alreadyExposed: string[];
    currentPositions: CurrentPositionContext[];
    vaultHistory: VaultHistoryContext[];
    recentLossExits: string[];
};

export function emptyPortfolioContext(): PortfolioContext {
    return {
        alreadyExposed: [],
        currentPositions: [],
        vaultHistory: [],
        recentLossExits: [],
    };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

export async function buildPortfolioContext(): Promise<PortfolioContext> {
    const wallet = process.env.WALLET as `0x${string}` | undefined;
    if (!wallet) return emptyPortfolioContext();

    let equities: { vaultAddress: string; equity: number }[] = [];
    try {
        equities = await HyperliquidConnector.getUserVaultEquities(wallet);
    } catch (error: any) {
        logger.warn("buildPortfolioContext: equities fetch failed", {
            error: error?.message,
        });
    }

    const history = await readVaultHistorySummaries().catch(() => null);
    const lastDeposits = await readLastDepositTimes().catch(() => null);
    const lossExits = await readRecentLossExitVaults(
        REENTRY_COOLDOWN_DAYS
    ).catch(() => null);
    const historyByAddr = new Map<string, VaultHistorySummary>();
    for (const entry of history ?? []) {
        historyByAddr.set(entry.vaultAddress.toLowerCase(), entry);
    }

    const now = Date.now();
    const alreadyExposed: string[] = [];
    const currentPositions: CurrentPositionContext[] = [];
    const seen = new Set<string>();
    for (const entry of equities) {
        if (!entry?.vaultAddress) continue;
        const addr = String(entry.vaultAddress).toLowerCase();
        if (seen.has(addr)) continue;
        seen.add(addr);
        alreadyExposed.push(addr);
        const equity = Number(entry.equity);
        if (!Number.isFinite(equity) || equity < DUST_THRESHOLD_USD) continue;
        const h = historyByAddr.get(addr);
        const basis = h?.openBasisUsd ?? 0;
        const roePct = basis > 0 ? ((equity - basis) / basis) * 100 : null;
        const lastDeposit = lastDeposits?.get(addr) ?? null;
        currentPositions.push({
            address: addr,
            current_usd: round2(equity),
            roe_pct: roePct != null ? round2(roePct) : null,
            hold_days:
                lastDeposit != null
                    ? round1((now - lastDeposit) / MS_PER_DAY)
                    : null,
        });
    }

    // Keep only rows that carry signal: vaults we still hold or where we
    // actually realized something. ~1 line per vault in the prompt.
    const vaultHistory: VaultHistoryContext[] = (history ?? [])
        .filter((h) => h.isOpen || Math.abs(h.realizedPnlUsd) >= 0.5)
        .map((h) => ({
            address: h.vaultAddress.toLowerCase(),
            episodes: h.episodes,
            realized_pnl_usd: round2(h.realizedPnlUsd),
            currently_held: h.isOpen,
        }));

    return {
        alreadyExposed,
        currentPositions,
        vaultHistory,
        recentLossExits: (lossExits ?? []).map((a) => a.toLowerCase()),
    };
}
