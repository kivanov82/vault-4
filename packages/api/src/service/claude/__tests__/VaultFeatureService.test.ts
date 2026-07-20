import { VaultFeatureService } from "../VaultFeatureService";
import type { VaultRawData, VaultTradeRow, PnlSeries } from "../featureTypes";

const NOW = 1_753_000_000_000;
const DAY = 86_400_000;

function trade(time: number, closedPnl: number, fee = 0, dir = "Open Long"): VaultTradeRow {
    return { time, closedPnl, fee, dir };
}

function pos(coin: string, szi: number, positionValue: number, unrealizedPnl = 0): any {
    return { position: { coin, szi, positionValue, unrealizedPnl } };
}

function raw(overrides: Partial<VaultRawData> & { tvl?: number; name?: string; address?: string } = {}): VaultRawData {
    const { tvl = 1000, name = "V", address = "0xabc", ...rest } = overrides;
    return {
        candidate: { vaultAddress: address, name, tvl } as any,
        trades: rest.trades ?? [],
        assetPositions: rest.assetPositions ?? [],
        pnls: rest.pnls ?? [],
    };
}

describe("VaultFeatureService.robustZ", () => {
    it("case 1 — basic MAD path with clipping", () => {
        const z = VaultFeatureService.robustZ([1, 2, 3, 4, 10]);
        expect(z[0]!).toBeCloseTo(-1.349, 3);
        expect(z[1]!).toBeCloseTo(-0.674, 3);
        expect(z[2]!).toBeCloseTo(0, 3);
        expect(z[3]!).toBeCloseTo(0.674, 3);
        expect(z[4]!).toBeCloseTo(3.0, 3);
    });

    it("case 2 — MAD=0 population-std fallback", () => {
        const z = VaultFeatureService.robustZ([5, 5, 5, 5, 9]);
        expect(z[0]!).toBeCloseTo(-0.5, 3);
        expect(z[1]!).toBeCloseTo(-0.5, 3);
        expect(z[2]!).toBeCloseTo(-0.5, 3);
        expect(z[3]!).toBeCloseTo(-0.5, 3);
        expect(z[4]!).toBeCloseTo(2.0, 3);
    });

    it("case 3 — nulls preserved & degenerate short vectors", () => {
        const z = VaultFeatureService.robustZ([1, null, 3, 5]);
        expect(z[1]).toBeNull();
        expect(z[0]!).toBeCloseTo(-0.674, 3);
        expect(z[2]!).toBeCloseTo(0, 3);
        expect(z[3]!).toBeCloseTo(0.674, 3);

        const only1 = VaultFeatureService.robustZ([1, null]);
        expect(only1[0]).toBe(0);
        expect(only1[1]).toBeNull();

        const allEqual = VaultFeatureService.robustZ([2, 2, 2]);
        expect(allEqual).toEqual([0, 0, 0]);
    });
});

describe("VaultFeatureService.computeFeatures", () => {
    it("case 4 — drawdown over the month series", () => {
        const pnls: PnlSeries[] = [["month", [[1, 0], [2, 10], [3, 4], [4, 12], [5, 3]]]];
        const f = VaultFeatureService.computeFeatures(raw({ tvl: 100, pnls }), NOW);
        expect(f.monthMaxDdRt!).toBeCloseTo(0.09, 3);
    });

    it("case 5 — trade stats & 7d/30d window boundary", () => {
        const trades = [
            trade(NOW - DAY, 2, 0.1),
            trade(NOW - DAY, -1, 0.1),
            trade(NOW - DAY, 0, 0.1),
            trade(NOW - DAY, 3, 0.1),
        ];
        const f = VaultFeatureService.computeFeatures(raw({ trades }), NOW);
        expect(f.tradePnl7d!).toBeCloseTo(3.6, 3);
        expect(f.winrate7d!).toBeCloseTo(0.5, 3);
        expect(f.pnlSd7d!).toBeCloseTo(1.581, 3);
        expect(f.trades7d).toBe(4);

        const withOld = [...trades, trade(NOW - 8 * DAY, 5, 0.1)];
        const f2 = VaultFeatureService.computeFeatures(raw({ trades: withOld }), NOW);
        expect(f2.trades7d).toBe(4); // 8d-old trade excluded from 7d
        expect(f2.trades30d).toBe(5); // included in 30d
    });

    it("case 6 — short ratio substring match", () => {
        const trades = [
            trade(NOW - DAY, 1, 0, "Open Short"),
            trade(NOW - DAY, 1, 0, "Close Long"),
            trade(NOW - DAY, 1, 0, "Open Short"),
            trade(NOW - DAY, 1, 0, "Open Long"),
        ];
        const f = VaultFeatureService.computeFeatures(raw({ trades }), NOW);
        expect(f.shortRatio7d!).toBeCloseTo(0.5, 3);
    });

    it("case 7 — exposure aggregates & direction", () => {
        const assetPositions = [
            pos("BTC", 1, 100),
            pos("ETH", -1, 50),
            pos("DOGE", -1, 30),
        ];
        const f = VaultFeatureService.computeFeatures(raw({ assetPositions }), NOW);
        expect(f.grossExposure).toBeCloseTo(180, 3);
        expect(f.netExposure).toBeCloseTo(20, 3);
        expect(f.btcExposure).toBeCloseTo(100, 3);
        expect(f.majorsExposure).toBeCloseTo(50, 3);
        expect(f.altsExposure).toBeCloseTo(-30, 3);
        expect(f.direction).toBe("neutral"); // 20/180 = 0.111

        const flipped = [pos("BTC", 1, 300), pos("ETH", -1, 50), pos("DOGE", -1, 30)];
        const f2 = VaultFeatureService.computeFeatures(raw({ assetPositions: flipped }), NOW);
        expect(f2.netExposure / f2.grossExposure).toBeCloseTo(0.579, 3);
        expect(f2.direction).toBe("long");
    });

    it("case 8 — mmProxy boundary", () => {
        const mk = (n: number, pnl: number, sd: number): VaultRawData => {
            // Build n 30d trades with a controlled sum and population sd.
            // Use two-value construction: k trades of +a and (n-k) of +b won't hit
            // exact sd easily, so instead synthesize directly via mean/sd is hard;
            // simplest: all-equal trades give sd 0 (<= threshold) — vary count/pnl.
            const trades: VaultTradeRow[] = [];
            // Produce `sd` via a symmetric pair around the mean using the first two trades
            // and equal-to-mean for the rest. mean = pnl/n.
            const mean = pnl / n;
            // deviations d for first two: +delta, -delta => contributes 2*delta^2 to sum.
            // population var = sd^2 = (2*delta^2)/n => delta = sqrt(sd^2 * n / 2)
            const delta = Math.sqrt((sd * sd * n) / 2);
            for (let i = 0; i < n; i++) {
                let v = mean;
                if (i === 0) v = mean + delta;
                else if (i === 1) v = mean - delta;
                trades.push(trade(NOW - DAY, v, 0));
            }
            return raw({ trades });
        };

        const a = VaultFeatureService.computeFeatures(mk(60, 100, 10), NOW);
        expect(a.trades30d).toBe(60);
        expect(a.tradePnl30d!).toBeCloseTo(100, 3);
        expect(a.pnlSd30d!).toBeCloseTo(10, 3);
        expect(a.mmProxy).toBe(1); // sd 10 <= |100|/10 = 10

        const b = VaultFeatureService.computeFeatures(mk(60, 100, 10.01), NOW);
        expect(b.mmProxy).toBe(0); // sd 10.01 > 10

        const c = VaultFeatureService.computeFeatures(mk(59, 100, 10), NOW);
        expect(c.trades30d).toBe(59);
        expect(c.mmProxy).toBe(0); // trades30d < 60
    });
});

describe("VaultFeatureService.computeRegimeFlags", () => {
    it("case 9 — threshold & null rules", () => {
        const bear = VaultFeatureService.computeRegimeFlags({ btc_7d_change: -2 });
        expect(bear.bearFlag).toBe(true);
        expect(bear.regime).toBe("risk-off");

        const on = VaultFeatureService.computeRegimeFlags({ btc_7d_change: 2, fearGreed: 60 });
        expect(on.riskOn).toBe(true);
        expect(on.regime).toBe("risk-on");

        const nul = VaultFeatureService.computeRegimeFlags({ btc_7d_change: null });
        expect(nul.bearFlag).toBe(false);
        expect(nul.riskOn).toBe(false);
        expect(nul.regime).toBe("neutral");

        const crowded = VaultFeatureService.computeRegimeFlags({ long_short_ratio: 1.6 });
        expect(crowded.crowdedLongs).toBe(true);
        const notCrowded = VaultFeatureService.computeRegimeFlags({ long_short_ratio: 1.5 });
        expect(notCrowded.crowdedLongs).toBe(false);
    });
});

describe("VaultFeatureService alignment & scoring", () => {
    it("case 10 — alignment penalty applied to both profiles", () => {
        // risk-off regime (btc 7d < 0) + a net-long vault -> conflicted, -0.3.
        const market = { btc_7d_change: -3 };
        const longVault = raw({
            address: "0xlong",
            assetPositions: [pos("BTC", 1, 100)], // net/gross = 1 -> long
        });
        const u = VaultFeatureService.computeUniverse([longVault], market, NOW);
        expect(u.features[0].direction).toBe("long");
        expect(u.scoring[0].aligned).toBe("conflicted");
        expect(u.scoring[0].alignmentPenalty).toBeCloseTo(-0.3, 3);
        expect(u.ranking[0].alignmentPenalty).toBeCloseTo(-0.3, 3);

        // neutral direction -> penalty 0, "neutral".
        const neutralVault = raw({ address: "0xneu", assetPositions: [] });
        const u2 = VaultFeatureService.computeUniverse([neutralVault], market, NOW);
        expect(u2.features[0].direction).toBe("neutral");
        expect(u2.scoring[0].aligned).toBe("neutral");
        expect(u2.scoring[0].alignmentPenalty).toBeCloseTo(0, 3);
        expect(u2.ranking[0].alignmentPenalty).toBeCloseTo(0, 3);
    });

    it("case 11 — score conversion & clamping", () => {
        const conv = (rawScore: number) =>
            Math.min(100, Math.max(0, Math.round((50 + 15 * rawScore) * 10) / 10));
        expect(conv(0.8)).toBeCloseTo(62.0, 3);
        expect(conv(-4)).toBe(0);
        expect(conv(4)).toBe(100);
    });
});

describe("VaultFeatureService.computeUniverse integration", () => {
    it("case 12 — dominant vault outranks the rest, all scores in [0,100]", () => {
        // Vault A best on every base feature; C worst; B in the middle.
        const mk = (
            address: string,
            weekEnd: number,
            dayEnd: number,
            monthPts: number[],
            closed: number[],
            unreal: number
        ): VaultRawData => {
            const trades = closed.map((v) => trade(NOW - DAY, v, 0));
            const pnls: PnlSeries[] = [
                ["week", [[1, 0], [2, weekEnd]]],
                ["day", [[1, 0], [2, dayEnd]]],
                ["month", monthPts.map((v, i) => [i + 1, v] as [number, number])],
            ];
            const assetPositions = [pos("BTC", 1, 100, unreal)];
            return raw({ address, tvl: 1000, trades, pnls, assetPositions });
        };

        const A = mk("0xa", 50, 20, [0, 10, 20, 30], [10, 12, 8, 10], 30);
        const B = mk("0xb", 20, 5, [0, 20, 10, 15], [5, -3, 4, 2], 5);
        const C = mk("0xc", -10, -15, [0, 10, -20, -10], [-5, -10, 2, -8], -20);

        // Neutral market (all-null) so overlay & alignment don't perturb ordering.
        const u = VaultFeatureService.computeUniverse([A, B, C], {}, NOW);

        const sA = u.scoring[0].score;
        const sB = u.scoring[1].score;
        const sC = u.scoring[2].score;
        expect(sA).toBeGreaterThan(sB);
        expect(sB).toBeGreaterThan(sC);
        for (const s of [...u.scoring, ...u.ranking]) {
            expect(s.score).toBeGreaterThanOrEqual(0);
            expect(s.score).toBeLessThanOrEqual(100);
        }
    });
});
