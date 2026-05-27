import {
    MS_PER_DAY,
    applyAllocation,
    buildLedgerByVault,
    calcInceptionPnlPct,
    calcPnlPct,
    calcUnrealizedPnlFromLedger,
    calcVaultMaxDrawdownPct,
    calcWinRatePct,
    deriveEntryUsd,
    extractAccountEquity,
    findValueAtOrBefore,
    maxDrawdownFromPnls,
    rebasePortfolioPnl,
    safeRatio,
    scoreCandidate,
    toSignedDrawdownPct,
} from "../vaultMath";
import type { UserPortfolioSummary, VaultCandidate, VaultRecommendation } from "../types";
import type { UserLedgerUpdate } from "../../trade/HyperliquidConnector";

const portfolio = (
    accountEquity: Partial<Record<"24h" | "7d" | "30d" | "allTime", number | null>>
): UserPortfolioSummary =>
    ({
        userAddress: "0xuser",
        metrics: {
            pnl: { "24h": null, "7d": null, "30d": null, allTime: null },
            volume: { "24h": null, "7d": null, "30d": null, allTime: null },
            maxDrawdown: { "24h": null, "7d": null, "30d": null, allTime: null },
            accountEquity: {
                "24h": accountEquity["24h"] ?? null,
                "7d": accountEquity["7d"] ?? null,
                "30d": accountEquity["30d"] ?? null,
                allTime: accountEquity.allTime ?? null,
            },
        },
        history: { pnl: null, accountValue: null },
    }) as UserPortfolioSummary;

describe("extractAccountEquity (Bug 4 regression: HL accountEquity already includes vault equities)", () => {
    test("returns allTime equity when available", () => {
        expect(extractAccountEquity(portfolio({ allTime: 1000 }))).toBe(1000);
    });

    test("falls back to 30d, then 7d, then 24h when earlier windows are null", () => {
        expect(extractAccountEquity(portfolio({ "30d": 950 }))).toBe(950);
        expect(extractAccountEquity(portfolio({ "7d": 900 }))).toBe(900);
        expect(extractAccountEquity(portfolio({ "24h": 880 }))).toBe(880);
    });

    test("returns null when no finite window value exists", () => {
        // The bug fix: prefer the source-of-truth accountEquity field over
        // re-deriving from positions + investedUsd. If equity is absent, return
        // null rather than synthesizing — caller should fall back explicitly.
        expect(extractAccountEquity(portfolio({}))).toBeNull();
        expect(extractAccountEquity(null)).toBeNull();
    });

    test("ignores non-finite values in earlier windows and falls through", () => {
        expect(extractAccountEquity(portfolio({ allTime: NaN, "30d": 800 }))).toBe(800);
    });
});

describe("calcInceptionPnlPct (Bug 5 regression: vault-equity numerator, wallet-growth denominator)", () => {
    test("uses (walletValue - totalPnlNow) as denominator, NOT raw vaultEquity", () => {
        // realized=50, basisOpen=100, vaultEquity=180, wallet=530
        // totalPnlNow = 50 + (180-100) = 130
        // impliedSeed = 530 - 130 = 400
        // inceptionPct = 130/400 * 100 = 32.5%
        // If the buggy "denominator = vaultEquity" path were used, result would be 130/180 ≈ 72.2%.
        const result = calcInceptionPnlPct(50, 100, 180, 530);
        expect(result).not.toBeNull();
        expect(result!.totalPnlNow).toBe(130);
        expect(result!.impliedSeed).toBe(400);
        expect(result!.inceptionPct).toBeCloseTo(32.5, 5);
    });

    test("falls back to basisOpenTotal when wallet value is missing or makes implied seed non-positive", () => {
        // wallet=null → fallback to basisOpenTotal
        const r1 = calcInceptionPnlPct(50, 100, 180, null);
        expect(r1!.impliedSeed).toBe(100);
        expect(r1!.inceptionPct).toBeCloseTo(130, 5);

        // wallet=100, totalPnlNow=130 → 100-130 = -30 (non-positive) → fallback
        const r2 = calcInceptionPnlPct(50, 100, 180, 100);
        expect(r2!.impliedSeed).toBe(100);
    });

    test("returns null when vault equity is missing, zero, or non-positive (no inference)", () => {
        expect(calcInceptionPnlPct(50, 100, null, 500)).toBeNull();
        expect(calcInceptionPnlPct(50, 100, 0, 500)).toBeNull();
        expect(calcInceptionPnlPct(50, 100, -10, 500)).toBeNull();
    });

    test("returns null when basis is zero (no inception base to measure against)", () => {
        expect(calcInceptionPnlPct(0, 0, 100, 500)).toBeNull();
    });
});

describe("buildLedgerByVault", () => {
    test("sums deposits and reduces basis by basisUsd (not by cash received) on withdraw", () => {
        // Deposit $100, then withdraw with cash=$150 but basis=$100 → currentDeposits=$0.
        // Bug class: if we reduced by usdc instead of basisUsd, currentDeposits would
        // be -$50 (clamped to 0), but a later re-deposit would then show inflated
        // unrealized PnL because basis got "double-credited" the realized gain.
        const map = buildLedgerByVault(
            [
                { vault: "0xA", type: "vaultDeposit", usdc: 100, time: 1 },
                { vault: "0xA", type: "vaultWithdraw", usdc: 150, time: 2, basisUsd: 100 },
            ],
            1
        );
        expect(map.get("0xa")).toEqual({
            deposits: 100,
            withdrawals: 150,
            currentDeposits: 0,
        });
    });

    test("falls back to reducing by usdc when basisUsd is missing (HL omission)", () => {
        // Real-world: HL doesn't always populate basisUsd on every entry.
        // Fallback is to reduce by the cash amount. Over-reduces but never goes
        // negative (clamped at 0).
        const map = buildLedgerByVault(
            [
                { vault: "0xA", type: "vaultDeposit", usdc: 100, time: 1 },
                { vault: "0xA", type: "vaultWithdraw", usdc: 150, time: 2 },
            ],
            1
        );
        expect(map.get("0xa")?.currentDeposits).toBe(0);
    });

    test("groups by lowercased vault address (HL case may vary)", () => {
        const map = buildLedgerByVault(
            [{ vault: "0xAbCdEf", type: "vaultDeposit", usdc: 50, time: 1 }],
            1
        );
        expect(map.get("0xabcdef")?.deposits).toBe(50);
    });

    test("skips entries with missing or non-finite time", () => {
        const map = buildLedgerByVault(
            [
                { vault: "0xA", type: "vaultDeposit", usdc: 100 },
                { vault: "0xA", type: "vaultDeposit", usdc: 50, time: NaN },
                { vault: "0xA", type: "vaultDeposit", usdc: 25, time: 1 },
            ],
            1
        );
        expect(map.get("0xa")?.deposits).toBe(25);
    });

    test("processes entries in chronological order regardless of input order", () => {
        // Out-of-order input: withdraw arrives in the array before its deposit.
        // The sort inside the function must rescue this — otherwise the withdraw
        // would touch zero balance and the deposit would land later, leaving
        // currentDeposits = full deposit (wrong — should be near-zero).
        const map = buildLedgerByVault(
            [
                { vault: "0xA", type: "vaultWithdraw", usdc: 100, time: 2, basisUsd: 100 },
                { vault: "0xA", type: "vaultDeposit", usdc: 100, time: 1 },
            ],
            1
        );
        expect(map.get("0xa")?.currentDeposits).toBe(0);
    });
});

describe("calcUnrealizedPnlFromLedger", () => {
    test("returns amountUsd - currentDeposits when ledger is populated", () => {
        expect(
            calcUnrealizedPnlFromLedger(130, {
                deposits: 100,
                withdrawals: 0,
                currentDeposits: 100,
            })
        ).toBe(30);
    });

    test("returns null when ledger is missing (caller should fall back)", () => {
        expect(calcUnrealizedPnlFromLedger(130, undefined)).toBeNull();
    });

    test("returns null when currentDeposits is zero — prevents div-by-zero / NaN downstream", () => {
        // ROE = pnl / basis; if basis is 0 the result is undefined. Returning null
        // here forces the caller to compute ROE from a different source instead
        // of propagating a NaN that could spuriously trigger stop-loss.
        expect(
            calcUnrealizedPnlFromLedger(130, {
                deposits: 0,
                withdrawals: 0,
                currentDeposits: 0,
            })
        ).toBeNull();
    });

    test("returns null when amountUsd is non-finite", () => {
        expect(
            calcUnrealizedPnlFromLedger(null, {
                deposits: 100,
                withdrawals: 0,
                currentDeposits: 100,
            })
        ).toBeNull();
    });
});

describe("deriveEntryUsd", () => {
    test("prefers ledger.currentDeposits when positive (most accurate basis)", () => {
        expect(
            deriveEntryUsd(130, 30, {
                deposits: 200,
                withdrawals: 0,
                currentDeposits: 200,
            })
        ).toBe(200);
    });

    test("falls back to amountUsd - pnlUsd when ledger is missing or zeroed", () => {
        // ledger zeroed (e.g. no HL ledger updates yet) → compute from snapshot fields
        expect(deriveEntryUsd(130, 30)).toBe(100);
        expect(
            deriveEntryUsd(130, 30, {
                deposits: 0,
                withdrawals: 0,
                currentDeposits: 0,
            })
        ).toBe(100);
    });

    test("falls back to amountUsd when pnlUsd is unavailable", () => {
        expect(deriveEntryUsd(130, null)).toBe(130);
    });

    test("returns null when nothing is computable", () => {
        expect(deriveEntryUsd(null, null)).toBeNull();
    });
});

describe("maxDrawdownFromPnls", () => {
    test("computes percentage drawdown from peak account value (tvl + pnl series)", () => {
        // tvl=200, pnls=[ ['allTime', [[t,0],[t,100],[t,50]]] ]
        // account values: 200, 300, 250 → peak=300, trough=250 → dd = 50/300 = 16.67%
        const pnls = [["allTime", [[1, 0], [2, 100], [3, 50]]]];
        expect(maxDrawdownFromPnls(pnls, 200)).toBeCloseTo(16.67, 2);
    });

    test("returns null when there's no drawdown (monotone up)", () => {
        const pnls = [["allTime", [[1, 0], [2, 50], [3, 100]]]];
        expect(maxDrawdownFromPnls(pnls, 200)).toBeNull();
    });

    test("returns null for empty / short series and zero tvl", () => {
        expect(maxDrawdownFromPnls([], 200)).toBeNull();
        expect(maxDrawdownFromPnls([["allTime", [[1, 0]]]], 200)).toBeNull();
        expect(maxDrawdownFromPnls([["allTime", [[1, 0], [2, 50]]]], 0)).toBeNull();
    });

    test("skips non-finite pnl points without poisoning the running max", () => {
        const pnls = [["allTime", [[1, 0], [2, NaN], [3, 100], [4, 25]]]];
        // Skipping NaN: peak=300 at point 3, trough=225 at point 4, dd=25%
        expect(maxDrawdownFromPnls(pnls, 200)).toBeCloseTo(25, 2);
    });
});

describe("calcVaultMaxDrawdownPct", () => {
    test("simple peak-to-trough drawdown as a fraction (not percent)", () => {
        // Note: returns a FRACTION (0.0–1.0), not a percentage. Caller multiplies by 100.
        expect(calcVaultMaxDrawdownPct([
            { timestamp: 1, value: 100 },
            { timestamp: 2, value: 150 },
            { timestamp: 3, value: 50 },
            { timestamp: 4, value: 120 },
        ])).toBeCloseTo(100 / 150, 5);
    });

    test("returns 0 for monotone-increasing series", () => {
        expect(calcVaultMaxDrawdownPct([
            { timestamp: 1, value: 100 },
            { timestamp: 2, value: 200 },
        ])).toBe(0);
    });

    test("returns 0 for series with fewer than 2 points", () => {
        expect(calcVaultMaxDrawdownPct([])).toBe(0);
        expect(calcVaultMaxDrawdownPct([{ timestamp: 1, value: 100 }])).toBe(0);
    });

    test("ignores negative-peak segments (prevents bogus negative-denominator drawdowns)", () => {
        // If the early series went negative, that point is not a valid peak —
        // computing dd from it would yield nonsense.
        expect(calcVaultMaxDrawdownPct([
            { timestamp: 1, value: -10 },
            { timestamp: 2, value: 100 },
            { timestamp: 3, value: 80 },
        ])).toBeCloseTo(0.2, 5);
    });
});

describe("toSignedDrawdownPct (locks in the project-wide signed-drawdown convention)", () => {
    // Why this matters: a well-intentioned future reviewer might look at
    // `return -(... * 100)` inside calcProRataMaxDrawdownPct and "fix" the
    // sign, breaking the API contract that the frontend's formatPercentSigned
    // relies on. This test pins the contract.
    test("returns a NEGATIVE percentage from a positive drawdown fraction", () => {
        expect(toSignedDrawdownPct(0.195)).toBeCloseTo(-19.5, 5);
        expect(toSignedDrawdownPct(0.5)).toBe(-50);
    });

    test("returns 0 for a zero drawdown (no negation surprise on a flat series)", () => {
        // Note JS: -(0 * 100) === -0; spec-equal to 0 but `Object.is(-0, 0)` is false.
        // toBe uses Object.is, so we assert via toEqual / Math.abs instead.
        expect(Math.abs(toSignedDrawdownPct(0))).toBe(0);
    });

    test("matches readMaxDrawdownFromSeries sign convention (negative percentage)", () => {
        // The DB-backed helper readMaxDrawdownFromSeries returns negative
        // percentages by docstring: "peak-to-trough decline as a negative
        // percentage (e.g. -19.5)". toSignedDrawdownPct must agree.
        for (const dd of [0.01, 0.1, 0.3, 0.99]) {
            expect(toSignedDrawdownPct(dd)).toBeLessThan(0);
        }
    });
});

describe("calcPnlPct", () => {
    const now = Date.now();
    const withdraw = (
        opts: Partial<UserLedgerUpdate> & {
            time: number;
            usdc?: number;
            netWithdrawnUsd: number;
            basisUsd: number;
        }
    ): UserLedgerUpdate =>
        ({
            vault: "0xA",
            type: "vaultWithdraw",
            usdc: opts.usdc ?? opts.netWithdrawnUsd,
            ...opts,
        }) as UserLedgerUpdate;

    test("computes realized PnL% over the window from withdrawal basis vs cash", () => {
        // Two recent withdrawals: 1) basis $100 -> $150 (+50%); 2) basis $200 -> $250 (+25%)
        // totalPnl = 100, totalBasis = 300 → 33.33%
        const result = calcPnlPct(
            [
                withdraw({ time: now - 5 * MS_PER_DAY, netWithdrawnUsd: 150, basisUsd: 100 }),
                withdraw({ time: now - 10 * MS_PER_DAY, netWithdrawnUsd: 250, basisUsd: 200 }),
            ],
            1,
            30
        );
        expect(result).toBeCloseTo(33.33, 2);
    });

    test("excludes withdrawals older than the window", () => {
        // Window = 30 days; the only entry is 60 days old → no realized + no open → null.
        expect(
            calcPnlPct(
                [withdraw({ time: now - 60 * MS_PER_DAY, netWithdrawnUsd: 150, basisUsd: 100 })],
                1,
                30
            )
        ).toBeNull();
    });

    test("includes open positions when provided", () => {
        // Realized: empty. Open: amount=130, pnl=30 → basis=100, ratio=30%.
        const result = calcPnlPct([], 1, 30, [
            { amountUsd: 130, pnlUsd: 30 },
        ]);
        expect(result).toBeCloseTo(30, 5);
    });

    test("returns null when there's no basis to divide by", () => {
        expect(calcPnlPct([], 1, 30)).toBeNull();
    });
});

describe("calcWinRatePct", () => {
    const now = Date.now();
    const wd = (
        time: number,
        netWithdrawnUsd: number,
        basisUsd: number
    ): UserLedgerUpdate =>
        ({
            vault: "0xA",
            type: "vaultWithdraw",
            usdc: netWithdrawnUsd,
            time,
            netWithdrawnUsd,
            basisUsd,
        }) as UserLedgerUpdate;

    test("counts withdrawals where cash > basis as wins", () => {
        // 2 wins out of 3 → 66.67%
        const result = calcWinRatePct(
            [
                wd(now - 1 * MS_PER_DAY, 150, 100), // win
                wd(now - 2 * MS_PER_DAY, 200, 100), // win
                wd(now - 3 * MS_PER_DAY, 50, 100), // loss
            ],
            now - 30 * MS_PER_DAY,
            1
        );
        expect(result).toBeCloseTo(66.67, 2);
    });

    test("returns null when no withdrawals fall in the window", () => {
        expect(calcWinRatePct([], 0, 1)).toBeNull();
    });
});

describe("rebasePortfolioPnl", () => {
    const baseline = (points: { timestamp: number; value: number }[]): UserPortfolioSummary =>
        ({
            userAddress: "0xuser",
            metrics: {} as any,
            history: {
                pnl: { points },
                accountValue: null,
            },
        }) as UserPortfolioSummary;

    test("subtracts the baseline value from every post-sinceMs point", () => {
        const result = rebasePortfolioPnl(
            baseline([
                { timestamp: 100, value: 50 }, // pre-launch baseline = 50
                { timestamp: 200, value: 80 }, // post → 80 - 50 = 30
                { timestamp: 300, value: 120 }, // post → 70
            ]),
            150
        );
        expect(result!.history.pnl!.points).toEqual([
            { timestamp: 200, value: 30 },
            { timestamp: 300, value: 70 },
        ]);
    });

    test("returns the portfolio unchanged when there's no pnl history", () => {
        const empty = baseline([]);
        // Empty points → falls through the early-return path
        expect(rebasePortfolioPnl(empty, 150)).toBe(empty);
    });

    test("baseline falls back to first point's value when sinceMs is before all data", () => {
        const result = rebasePortfolioPnl(
            baseline([
                { timestamp: 200, value: 30 },
                { timestamp: 300, value: 80 },
            ]),
            100
        );
        // findValueAtOrBefore returns null (no point <= 100), so baseline = points[0].value = 30
        expect(result!.history.pnl!.points).toEqual([
            { timestamp: 200, value: 0 },
            { timestamp: 300, value: 50 },
        ]);
    });
});

describe("findValueAtOrBefore", () => {
    const series = [
        { timestamp: 10, value: 100 },
        { timestamp: 20, value: 200 },
        { timestamp: 30, value: 300 },
    ];

    test("returns the value at an exact-match timestamp", () => {
        expect(findValueAtOrBefore(series, 20)).toBe(200);
    });

    test("returns the previous value when the target falls between points", () => {
        expect(findValueAtOrBefore(series, 25)).toBe(200);
    });

    test("returns null when target is before the first point (no baseline available)", () => {
        // tvlChange30dUsd uses this — null means "no 30-day reference, don't compute delta"
        expect(findValueAtOrBefore(series, 5)).toBeNull();
    });

    test("returns the last value when target is after all points", () => {
        expect(findValueAtOrBefore(series, 100)).toBe(300);
    });

    test("returns null for empty input or non-finite target", () => {
        expect(findValueAtOrBefore([], 100)).toBeNull();
        expect(findValueAtOrBefore(series, NaN)).toBeNull();
    });
});

describe("applyAllocation", () => {
    const rec = (vaultAddress: string): VaultRecommendation =>
        ({
            vaultAddress,
            name: vaultAddress,
            confidence: "high",
            allocationPct: 0,
            metrics: {
                tvl: 0,
                weeklyPnl: 0,
                monthlyPnl: 0,
                allTimePnl: 0,
                ageDays: 0,
                followers: 0,
                tradesLast7d: 0,
            },
        }) as VaultRecommendation;

    test("splits a percentage evenly across recommendations, sum equals input", () => {
        const result = applyAllocation([rec("0xA"), rec("0xB"), rec("0xC")], 100);
        const sum = result.reduce((acc, r) => acc + r.allocationPct, 0);
        expect(sum).toBeCloseTo(100, 5);
    });

    test("applies the rounding correction to the first item (sum-preserving)", () => {
        // 100 / 3 = 33.333..., rounded = 33.33; 3*33.33 = 99.99; diff = 0.01
        // first item gets +0.01 → [33.34, 33.33, 33.33], sum=100.00
        const result = applyAllocation([rec("0xA"), rec("0xB"), rec("0xC")], 100);
        expect(result[0].allocationPct).toBeCloseTo(33.34, 5);
        expect(result[1].allocationPct).toBeCloseTo(33.33, 5);
        expect(result[2].allocationPct).toBeCloseTo(33.33, 5);
    });

    test("returns empty for empty input (no crash on Claude returning zero picks)", () => {
        expect(applyAllocation([], 100)).toEqual([]);
    });

    test("zero totalPct gives each item 0", () => {
        const result = applyAllocation([rec("0xA"), rec("0xB")], 0);
        expect(result.every((r) => r.allocationPct === 0)).toBe(true);
    });
});

describe("scoreCandidate", () => {
    const candidate = (overrides: Partial<VaultCandidate> = {}): VaultCandidate =>
        ({
            vaultAddress: "0xA",
            name: "v",
            tvl: 100000,
            ageDays: 60,
            isClosed: false,
            weeklyPnl: 500,
            monthlyPnl: 1500,
            allTimePnl: 10000,
            followers: 100,
            allowDeposits: true,
            tradesLast7d: 50,
            performance: {} as any,
            raw: {} as any,
            ...overrides,
        }) as VaultCandidate;

    test("returns a finite score for normal inputs", () => {
        expect(Number.isFinite(scoreCandidate(candidate()))).toBe(true);
    });

    test("propagates no NaN when weeklyPnl / monthlyPnl are null (safeRatio swallows)", () => {
        // The safeRatio guard exists specifically because Claude scoring runs on
        // every candidate every round — one NaN poisons the sort and the whole
        // ranking output becomes nondeterministic.
        const score = scoreCandidate(candidate({ weeklyPnl: null, monthlyPnl: null }));
        expect(Number.isFinite(score)).toBe(true);
    });

    test("tvl=0 doesn't produce -Infinity from log10", () => {
        expect(Number.isFinite(scoreCandidate(candidate({ tvl: 0 })))).toBe(true);
    });

    test("higher recent PnL yields higher score (weeklyPnl weighted 400× ratio)", () => {
        const low = scoreCandidate(candidate({ weeklyPnl: 100 }));
        const high = scoreCandidate(candidate({ weeklyPnl: 5000 }));
        expect(high).toBeGreaterThan(low);
    });
});

describe("safeRatio", () => {
    test("returns 0 for null value or zero denom (no div-by-zero, no NaN)", () => {
        expect(safeRatio(null, 100)).toBe(0);
        expect(safeRatio(50, 0)).toBe(0);
    });

    test("returns 0 for non-finite inputs", () => {
        expect(safeRatio(NaN, 100)).toBe(0);
        expect(safeRatio(50, NaN)).toBe(0);
    });

    test("computes the ratio for finite inputs", () => {
        expect(safeRatio(50, 200)).toBe(0.25);
        expect(safeRatio(-30, 100)).toBe(-0.3);
    });
});
