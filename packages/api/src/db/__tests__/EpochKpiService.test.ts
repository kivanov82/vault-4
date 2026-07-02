import {
    computeCloseStats,
    computeEpochLedgerStats,
    type RawLedgerRow,
} from "../EpochKpiService";

const DAY = 24 * 60 * 60 * 1000;
const EPOCH = Date.UTC(2026, 6, 2); // 2026-07-02

const deposit = (
    vault: string,
    time: number,
    usd: number
): RawLedgerRow => ({
    time,
    vaultAddress: vault,
    type: "vaultDeposit",
    usdc: usd,
    netWithdrawnUsd: null,
    basisUsdHl: null,
});

const withdraw = (
    vault: string,
    time: number,
    net: number,
    preEquityUsd?: number
): RawLedgerRow => ({
    time,
    vaultAddress: vault,
    type: "vaultWithdraw",
    usdc: net,
    netWithdrawnUsd: net,
    basisUsdHl: null,
});

describe("computeEpochLedgerStats", () => {
    it("carries pre-epoch basis into epoch closes", () => {
        // $100 deposited before the epoch, fully withdrawn for $110 after it:
        // the +$10 realized must land in the epoch with the pre-epoch basis.
        const rows = [
            deposit("0xa", EPOCH - 10 * DAY, 100),
            withdraw("0xa", EPOCH + 1 * DAY, 110),
        ];
        const stats = computeEpochLedgerStats(rows, EPOCH);
        expect(stats.closes).toHaveLength(1);
        expect(stats.closes[0].realizedPnlUsd).toBeCloseTo(10, 6);
        expect(stats.closes[0].basisConsumedUsd).toBeCloseTo(100, 6);
        expect(stats.openBasisUsd).toBe(0);
        // the pre-epoch deposit is not an epoch deposit
        expect(stats.deposits.count).toBe(0);
    });

    it("excludes pre-epoch closes entirely", () => {
        const rows = [
            deposit("0xa", EPOCH - 20 * DAY, 100),
            withdraw("0xa", EPOCH - 5 * DAY, 80), // -$20, before the epoch
            deposit("0xb", EPOCH + 1 * DAY, 200),
        ];
        const stats = computeEpochLedgerStats(rows, EPOCH);
        expect(stats.closes).toHaveLength(0);
        expect(stats.deposits).toEqual({ count: 1, totalUsd: 200 });
        expect(stats.openBasisUsd).toBeCloseTo(200, 2);
    });

    it("tracks per-vault FIFO independently", () => {
        const rows = [
            deposit("0xa", EPOCH + 1 * DAY, 100),
            deposit("0xb", EPOCH + 1 * DAY, 100),
            withdraw("0xa", EPOCH + 3 * DAY, 90), // -$10
            withdraw("0xb", EPOCH + 3 * DAY, 115), // +$15
        ];
        const stats = computeEpochLedgerStats(rows, EPOCH);
        const byVault = Object.fromEntries(
            stats.closes.map((c) => [c.vaultAddress, c.realizedPnlUsd])
        );
        expect(byVault["0xa"]).toBeCloseTo(-10, 6);
        expect(byVault["0xb"]).toBeCloseTo(15, 6);
    });
});

describe("computeCloseStats", () => {
    const close = (pnl: number, basis: number) => ({
        time: EPOCH,
        vaultAddress: "0xa",
        realizedPnlUsd: pnl,
        basisConsumedUsd: basis,
    });

    it("computes the full KPI block", () => {
        const stats = computeCloseStats([
            close(10, 200), // win
            close(20, 200), // win
            close(-5, 200), // loss, -2.5% of basis → churn
            close(-25, 100), // loss, -25% of basis → not churn
            close(0.01, 200), // flat
        ]);
        expect(stats.count).toBe(5);
        expect(stats.wins).toBe(2);
        expect(stats.losses).toBe(2);
        expect(stats.flats).toBe(1);
        expect(stats.winRatePct).toBeCloseTo(50, 2);
        expect(stats.grossWinsUsd).toBeCloseTo(30, 2);
        expect(stats.grossLossesUsd).toBeCloseTo(30, 2);
        expect(stats.avgWinUsd).toBeCloseTo(15, 2);
        expect(stats.avgLossUsd).toBeCloseTo(15, 2);
        expect(stats.winLossRatio).toBeCloseTo(1, 2);
        expect(stats.profitFactor).toBeCloseTo(1, 2);
        expect(stats.expectancyUsdPerClose).toBeCloseTo(0, 2);
        expect(stats.realizedPnlUsd).toBeCloseTo(0.01, 2);
        expect(stats.churn).toEqual({ count: 1, lossUsd: 5 });
    });

    it("handles the empty epoch (fresh start)", () => {
        const stats = computeCloseStats([]);
        expect(stats.count).toBe(0);
        expect(stats.winRatePct).toBeNull();
        expect(stats.avgWinUsd).toBeNull();
        expect(stats.avgLossUsd).toBeNull();
        expect(stats.winLossRatio).toBeNull();
        expect(stats.profitFactor).toBeNull();
        expect(stats.expectancyUsdPerClose).toBeNull();
        expect(stats.realizedPnlUsd).toBe(0);
    });

    it("all-wins epoch has null profit factor (no losses) not Infinity", () => {
        const stats = computeCloseStats([close(10, 100), close(5, 100)]);
        expect(stats.profitFactor).toBeNull();
        expect(stats.winLossRatio).toBeNull();
        expect(stats.expectancyUsdPerClose).toBeCloseTo(7.5, 2);
    });

    it("churn requires a consumed basis to normalize against", () => {
        const stats = computeCloseStats([close(-1, 0)]);
        expect(stats.churn.count).toBe(0);
        expect(stats.losses).toBe(1);
    });
});
