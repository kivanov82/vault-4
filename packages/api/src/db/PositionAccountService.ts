import type { PoolClient } from "pg";
import { withDb } from "./pool";

export type Lot = {
    depositedAt: Date;
    originalUsd: number;
    remainingBasisUsd: number;
};

export type AccountState = {
    vaultAddress: string;
    lots: Lot[];
    cumulativeDepositsUsd: number;
    cumulativeWithdrawsNetUsd: number;
    realizedPnlUsdTotal: number;
    depositCount: number;
    withdrawCount: number;
    firstDepositAt: Date | null;
    lastEventAt: Date | null;
};

export type LedgerEvent = {
    time: Date;
    type: "vaultDeposit" | "vaultWithdraw";
    usdc: number;
    netWithdrawnUsd?: number | null;
    basisUsdHl?: number | null;
    preEquityUsd?: number | null;
};

export type ApplyResult = {
    state: AccountState;
    basisConsumed: number;
    realizedPnl: number;
};

export function createEmptyState(vaultAddress: string): AccountState {
    return {
        vaultAddress: vaultAddress.toLowerCase(),
        lots: [],
        cumulativeDepositsUsd: 0,
        cumulativeWithdrawsNetUsd: 0,
        realizedPnlUsdTotal: 0,
        depositCount: 0,
        withdrawCount: 0,
        firstDepositAt: null,
        lastEventAt: null,
    };
}

export function totalOpenBasis(state: AccountState): number {
    return state.lots.reduce((s, l) => s + l.remainingBasisUsd, 0);
}

export function applyEvent(
    state: AccountState,
    event: LedgerEvent
): ApplyResult {
    if (event.type === "vaultDeposit") {
        const lot: Lot = {
            depositedAt: event.time,
            originalUsd: event.usdc,
            remainingBasisUsd: event.usdc,
        };
        const next: AccountState = {
            ...state,
            lots: [...state.lots, lot],
            cumulativeDepositsUsd: state.cumulativeDepositsUsd + event.usdc,
            depositCount: state.depositCount + 1,
            firstDepositAt: state.firstDepositAt ?? event.time,
            lastEventAt: event.time,
        };
        return { state: next, basisConsumed: 0, realizedPnl: 0 };
    }

    const netReceived = Number.isFinite(event.netWithdrawnUsd)
        ? Number(event.netWithdrawnUsd)
        : event.usdc;
    const openBasis = totalOpenBasis(state);

    let basisConsumed: number;
    if (openBasis <= 0) {
        basisConsumed = 0;
    } else if (netReceived <= 0) {
        // Zero-cash withdraw (cancelled request, settlement no-op, dust). No
        // basis to consume regardless of what HL reports — without this guard
        // the fallback below would zero out the entire position.
        basisConsumed = 0;
    } else if (event.preEquityUsd != null && event.preEquityUsd > 0) {
        const fraction = Math.min(1, netReceived / event.preEquityUsd);
        basisConsumed = openBasis * fraction;
    } else if (event.basisUsdHl != null && event.basisUsdHl >= 0) {
        // Honour HL's explicit basis figure, including 0 (some no-op events
        // come through with basis=0; treating that as "unknown" used to
        // trigger the consume-all fallback and corrupt basis).
        basisConsumed = Math.min(event.basisUsdHl, openBasis);
    } else {
        basisConsumed = openBasis;
    }

    let remaining = basisConsumed;
    const newLots: Lot[] = [];
    for (const lot of state.lots) {
        if (remaining <= 0) {
            newLots.push(lot);
            continue;
        }
        if (lot.remainingBasisUsd <= remaining + 1e-9) {
            remaining -= lot.remainingBasisUsd;
        } else {
            newLots.push({
                ...lot,
                remainingBasisUsd: lot.remainingBasisUsd - remaining,
            });
            remaining = 0;
        }
    }

    const realizedPnl = netReceived - basisConsumed;
    const next: AccountState = {
        ...state,
        lots: newLots,
        cumulativeWithdrawsNetUsd: state.cumulativeWithdrawsNetUsd + netReceived,
        realizedPnlUsdTotal: state.realizedPnlUsdTotal + realizedPnl,
        withdrawCount: state.withdrawCount + 1,
        lastEventAt: event.time,
    };
    return { state: next, basisConsumed, realizedPnl };
}

export function replayLedger(
    vaultAddress: string,
    events: LedgerEvent[]
): AccountState {
    const sorted = [...events].sort(
        (a, b) => a.time.getTime() - b.time.getTime()
    );
    let state = createEmptyState(vaultAddress);
    for (const ev of sorted) {
        state = applyEvent(state, ev).state;
    }
    return state;
}

async function loadEventsForVault(
    client: PoolClient,
    vaultAddress: string
): Promise<LedgerEvent[]> {
    const result = await client.query<{
        time: Date;
        type: "vaultDeposit" | "vaultWithdraw";
        usdc: string;
        net_withdrawn_usd: string | null;
        basis_usd_hl: string | null;
    }>(
        `SELECT time, type, usdc, net_withdrawn_usd, basis_usd_hl
         FROM position_ledger
         WHERE LOWER(vault_address) = LOWER($1)
         ORDER BY time ASC, id ASC`,
        [vaultAddress]
    );
    return result.rows.map((r) => ({
        time: r.time,
        type: r.type,
        usdc: Number(r.usdc),
        netWithdrawnUsd: r.net_withdrawn_usd != null ? Number(r.net_withdrawn_usd) : null,
        basisUsdHl: r.basis_usd_hl != null ? Number(r.basis_usd_hl) : null,
    }));
}

export async function getAccountStateFor(
    vaultAddress: string
): Promise<AccountState | null> {
    return (
        (await withDb<AccountState>(
            "getAccountStateFor",
            async (client) => {
                const events = await loadEventsForVault(client, vaultAddress);
                return replayLedger(vaultAddress, events);
            }
        )) ?? null
    );
}

async function upsertAccount(
    client: PoolClient,
    state: AccountState
): Promise<void> {
    const isOpen = state.lots.length > 0 && totalOpenBasis(state) > 0;
    await client.query(
        `INSERT INTO position_account (
            vault_address, first_deposit_at, last_event_at,
            cumulative_deposits_usd, cumulative_withdraws_net_usd,
            our_basis_usd_open, our_realized_pnl_usd_total,
            is_open, deposit_count, withdraw_count, recomputed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
        ON CONFLICT (vault_address) DO UPDATE SET
            first_deposit_at = EXCLUDED.first_deposit_at,
            last_event_at = EXCLUDED.last_event_at,
            cumulative_deposits_usd = EXCLUDED.cumulative_deposits_usd,
            cumulative_withdraws_net_usd = EXCLUDED.cumulative_withdraws_net_usd,
            our_basis_usd_open = EXCLUDED.our_basis_usd_open,
            our_realized_pnl_usd_total = EXCLUDED.our_realized_pnl_usd_total,
            is_open = EXCLUDED.is_open,
            deposit_count = EXCLUDED.deposit_count,
            withdraw_count = EXCLUDED.withdraw_count,
            recomputed_at = now()`,
        [
            state.vaultAddress,
            state.firstDepositAt,
            state.lastEventAt,
            state.cumulativeDepositsUsd,
            state.cumulativeWithdrawsNetUsd,
            totalOpenBasis(state),
            state.realizedPnlUsdTotal,
            isOpen,
            state.depositCount,
            state.withdrawCount,
        ]
    );
}

export async function recomputeAccountFor(
    vaultAddress: string
): Promise<AccountState | null> {
    return (
        (await withDb<AccountState>(
            "recomputeAccountFor",
            async (client) => {
                const events = await loadEventsForVault(client, vaultAddress);
                const state = replayLedger(vaultAddress, events);
                await upsertAccount(client, state);
                return state;
            }
        )) ?? null
    );
}

export async function recomputeAllAccounts(): Promise<number> {
    const result = await withDb<number>(
        "recomputeAllAccounts",
        async (client) => {
            const vaults = await client.query<{ vault_address: string }>(
                `SELECT DISTINCT LOWER(vault_address) AS vault_address
                 FROM position_ledger`
            );
            for (const row of vaults.rows) {
                const events = await loadEventsForVault(
                    client,
                    row.vault_address
                );
                const state = replayLedger(row.vault_address, events);
                await upsertAccount(client, state);
            }
            return vaults.rows.length;
        },
        0
    );
    return result ?? 0;
}
