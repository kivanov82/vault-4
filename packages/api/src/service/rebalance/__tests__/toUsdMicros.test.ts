import { toUsdMicros, toUsdMicrosFromDeposit } from "../usdMicros";

describe("toUsdMicros", () => {
    test("subtracts the buffer in bps and converts to integer micros", () => {
        // $100 with a 10bps (0.10%) safety buffer → 99.9 → 99900000 micros
        // The buffer exists because HL rejects deposits that exceed actual balance
        // by even a sub-cent rounding error.
        expect(toUsdMicros(100, 10)).toBe(99_900_000);
    });

    test("zero buffer passes the full amount through, floored", () => {
        expect(toUsdMicros(100, 0)).toBe(100_000_000);
    });

    test("returns 0 for non-positive amounts", () => {
        expect(toUsdMicros(0, 10)).toBe(0);
        expect(toUsdMicros(-5, 10)).toBe(0);
    });

    test("returns 0 for NaN / non-finite amounts", () => {
        expect(toUsdMicros(NaN, 10)).toBe(0);
        expect(toUsdMicros(Infinity, 10)).toBe(0);
    });

    test("floors sub-micro amounts to zero", () => {
        // 0.0000001 USD * 1e6 = 0.1 → floor = 0
        expect(toUsdMicros(0.0000001, 0)).toBe(0);
    });
});

describe("toUsdMicrosFromDeposit", () => {
    test("uses usdMicros directly when provided, floored to integer", () => {
        expect(
            toUsdMicrosFromDeposit({
usdMicros: 5_000_000,
            })
        ).toBe(5_000_000);

        // Float micros must floor — rounding up would exceed actual balance.
        expect(
            toUsdMicrosFromDeposit({
usdMicros: 5_000_000.9,
            })
        ).toBe(5_000_000);
    });

    test("converts amountUsd to micros when usdMicros is absent", () => {
        expect(
            toUsdMicrosFromDeposit({
amountUsd: 10.5,
            })
        ).toBe(10_500_000);
    });

    test("usdMicros wins when both fields are present", () => {
        expect(
            toUsdMicrosFromDeposit({
usdMicros: 3_000_000,
                amountUsd: 9.99,
            })
        ).toBe(3_000_000);
    });

    test("returns 0 when neither field is provided", () => {
        expect(toUsdMicrosFromDeposit({})).toBe(0);
    });

    test("clamps negative inputs to 0", () => {
        expect(toUsdMicrosFromDeposit({ amountUsd: -5 })).toBe(0);
    });
});
