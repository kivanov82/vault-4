import {
    applyEvent,
    createEmptyState,
    replayLedger,
    totalOpenBasis,
    LedgerEvent,
} from "../PositionAccountService";

const t = (iso: string) => new Date(iso);
const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

describe("PositionAccountService FIFO", () => {
    test("single deposit + full exit at gain", () => {
        const events: LedgerEvent[] = [
            { time: t("2026-01-01"), type: "vaultDeposit", usdc: 100 },
            {
                time: t("2026-02-01"),
                type: "vaultWithdraw",
                usdc: 150,
                netWithdrawnUsd: 150,
                preEquityUsd: 150,
            },
        ];
        const state = replayLedger("0xA", events);
        expect(round(totalOpenBasis(state))).toBe(0);
        expect(round(state.realizedPnlUsdTotal)).toBe(50);
        expect(state.depositCount).toBe(1);
        expect(state.withdrawCount).toBe(1);
    });

    test("single deposit + partial withdraw uses proportional FIFO when preEquity known", () => {
        const events: LedgerEvent[] = [
            { time: t("2026-01-01"), type: "vaultDeposit", usdc: 100 },
            {
                time: t("2026-02-01"),
                type: "vaultWithdraw",
                usdc: 30,
                netWithdrawnUsd: 30,
                preEquityUsd: 150,
            },
        ];
        const state = replayLedger("0xA", events);
        // withdraw 30/150 = 20% of equity → consume 20% of $100 basis = $20
        // realized = 30 - 20 = 10. remaining basis = 80.
        expect(round(totalOpenBasis(state))).toBe(80);
        expect(round(state.realizedPnlUsdTotal)).toBe(10);
    });

    test("multi-deposit re-entry: FIFO drains oldest lot first", () => {
        // Deposit $100 → grows to $150 → partial withdraw $60 → redeposit $80 → full exit $130
        const events: LedgerEvent[] = [
            { time: t("2026-01-01"), type: "vaultDeposit", usdc: 100 },
            {
                time: t("2026-02-01"),
                type: "vaultWithdraw",
                usdc: 60,
                netWithdrawnUsd: 60,
                preEquityUsd: 150,
            },
            { time: t("2026-03-01"), type: "vaultDeposit", usdc: 80 },
            {
                time: t("2026-04-01"),
                type: "vaultWithdraw",
                usdc: 130,
                netWithdrawnUsd: 130,
                preEquityUsd: 130,
            },
        ];
        const state = replayLedger("0xA", events);
        // Step 2: 60/150 = 0.4; consume 40% of $100 basis = $40 → realized 60-40=20, lot1 left $60
        // Step 3: push lot2 $80 → open basis = $60 + $80 = $140
        // Step 4: full exit (fraction = 130/130 = 1.0) → consume all $140 → realized 130-140 = -10
        // Total realized: 20 + (-10) = 10
        expect(round(totalOpenBasis(state))).toBe(0);
        expect(round(state.realizedPnlUsdTotal)).toBe(10);
        // Sanity: net cash = -100 + 60 - 80 + 130 = 10. ✓
    });

    test("falls back to HL basis when preEquity unavailable", () => {
        const events: LedgerEvent[] = [
            { time: t("2026-01-01"), type: "vaultDeposit", usdc: 100 },
            {
                time: t("2026-02-01"),
                type: "vaultWithdraw",
                usdc: 30,
                netWithdrawnUsd: 30,
                basisUsdHl: 20,
            },
        ];
        const state = replayLedger("0xA", events);
        expect(round(totalOpenBasis(state))).toBe(80);
        expect(round(state.realizedPnlUsdTotal)).toBe(10);
    });

    test("falls back to full-exit assumption when both preEquity and HL basis missing", () => {
        const events: LedgerEvent[] = [
            { time: t("2026-01-01"), type: "vaultDeposit", usdc: 100 },
            {
                time: t("2026-02-01"),
                type: "vaultWithdraw",
                usdc: 120,
                netWithdrawnUsd: 120,
            },
        ];
        const state = replayLedger("0xA", events);
        expect(round(totalOpenBasis(state))).toBe(0);
        expect(round(state.realizedPnlUsdTotal)).toBe(20);
    });

    test("loss case: deposit $100, full exit $40", () => {
        const events: LedgerEvent[] = [
            { time: t("2026-01-01"), type: "vaultDeposit", usdc: 100 },
            {
                time: t("2026-02-01"),
                type: "vaultWithdraw",
                usdc: 40,
                netWithdrawnUsd: 40,
                preEquityUsd: 40,
            },
        ];
        const state = replayLedger("0xA", events);
        expect(round(totalOpenBasis(state))).toBe(0);
        expect(round(state.realizedPnlUsdTotal)).toBe(-60);
    });

    test("event ordering is enforced by timestamp", () => {
        const events: LedgerEvent[] = [
            {
                time: t("2026-02-01"),
                type: "vaultWithdraw",
                usdc: 100,
                netWithdrawnUsd: 100,
                preEquityUsd: 100,
            },
            { time: t("2026-01-01"), type: "vaultDeposit", usdc: 100 },
        ];
        const state = replayLedger("0xA", events);
        expect(round(totalOpenBasis(state))).toBe(0);
        expect(round(state.realizedPnlUsdTotal)).toBe(0);
    });

    test("aggregates: deposits, withdraws, counts", () => {
        const events: LedgerEvent[] = [
            { time: t("2026-01-01"), type: "vaultDeposit", usdc: 100 },
            { time: t("2026-01-15"), type: "vaultDeposit", usdc: 50 },
            {
                time: t("2026-02-01"),
                type: "vaultWithdraw",
                usdc: 75,
                netWithdrawnUsd: 75,
                preEquityUsd: 150,
            },
        ];
        const state = replayLedger("0xA", events);
        expect(round(state.cumulativeDepositsUsd)).toBe(150);
        expect(round(state.cumulativeWithdrawsNetUsd)).toBe(75);
        expect(state.depositCount).toBe(2);
        expect(state.withdrawCount).toBe(1);
    });
});
