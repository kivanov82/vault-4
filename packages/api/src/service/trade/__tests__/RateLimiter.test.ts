import { RateLimiter, weightForUrl, retryAfterMs } from "../RateLimiter";

// Flush the microtask queue a few times so resolved acquire() promises run
// their .then() callbacks after we synchronously advance the fake timers.
const tick = async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

describe("RateLimiter token bucket", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test("serves a burst up to capacity instantly, then paces by refill rate", async () => {
        // 60000 weight/min => 1 token/ms. burst 100 => exactly five weight-20
        // calls clear instantly; the sixth must wait for 20 tokens (=20ms).
        const rl = new RateLimiter({ weightPerMin: 60000, burst: 100, penaltyMs: 1000 });
        let resolved = 0;
        const ps = Array.from({ length: 6 }, () =>
            rl.acquire(20).then(() => {
                resolved += 1;
            })
        );

        await tick();
        expect(resolved).toBe(5); // drained the 100-token burst

        jest.advanceTimersByTime(19);
        await tick();
        expect(resolved).toBe(5); // 19 tokens < 20, sixth still waiting

        jest.advanceTimersByTime(1);
        await tick();
        expect(resolved).toBe(6); // 20th token accrued

        await Promise.all(ps);
    });

    test("sustained throughput never exceeds the configured weight/min", async () => {
        // 1200 weight/min, burst 0-effect (small). Fire 120 weight-20 calls and
        // confirm it takes ~ (120*20)/1200 minutes worth of simulated time, i.e.
        // the bucket gates rather than letting them all through at once.
        const rl = new RateLimiter({ weightPerMin: 1200, burst: 20, penaltyMs: 0 });
        let resolved = 0;
        const ps = Array.from({ length: 10 }, () =>
            rl.acquire(20).then(() => {
                resolved += 1;
            })
        );
        await tick();
        expect(resolved).toBe(1); // burst=20 => only one weight-20 call up front

        // refill is 1200/60000 = 0.02 tokens/ms => 20 tokens every 1000ms.
        jest.advanceTimersByTime(1000);
        await tick();
        expect(resolved).toBe(2);

        jest.advanceTimersByTime(8000);
        await tick();
        expect(resolved).toBe(10);

        await Promise.all(ps);
    });

    test("higher priority jumps ahead of background traffic", async () => {
        const rl = new RateLimiter({ weightPerMin: 60000, burst: 20, penaltyMs: 1000 });
        await rl.acquire(20); // drain the burst
        await tick();

        const order: string[] = [];
        const low = rl.acquire(20, 0).then(() => order.push("low"));
        const high = rl.acquire(20, 10).then(() => order.push("high"));

        jest.advanceTimersByTime(20); // refill enough for exactly one
        await tick();
        expect(order).toEqual(["high"]);

        jest.advanceTimersByTime(20);
        await tick();
        expect(order).toEqual(["high", "low"]);

        await Promise.all([low, high]);
    });

    test("a 429 penalty pauses dispatch for the whole fleet", async () => {
        const rl = new RateLimiter({ weightPerMin: 60000, burst: 100, penaltyMs: 1000 });
        rl.penalize(); // drains tokens + pauses 1000ms

        let done = false;
        const p = rl.acquire(20).then(() => {
            done = true;
        });

        jest.advanceTimersByTime(500);
        await tick();
        expect(done).toBe(false); // still inside the cooldown

        jest.advanceTimersByTime(500);
        await tick();
        expect(done).toBe(true); // cooldown elapsed, tokens refilled

        await p;
    });

    test("penalty honors Retry-After when longer than the base cooldown", async () => {
        const rl = new RateLimiter({ weightPerMin: 60000, burst: 100, penaltyMs: 1000 });
        rl.penalize(3000); // Retry-After: 3s > 1s base

        let done = false;
        const p = rl.acquire(20).then(() => {
            done = true;
        });

        jest.advanceTimersByTime(1500);
        await tick();
        expect(done).toBe(false);

        jest.advanceTimersByTime(1500);
        await tick();
        expect(done).toBe(true);

        await p;
    });
});

describe("weightForUrl", () => {
    test("exchange actions are cheap, info defaults to the common weight", () => {
        expect(weightForUrl("https://api.hyperliquid.xyz/exchange")).toBe(1);
        expect(weightForUrl("https://api.hyperliquid.xyz/info")).toBe(20);
        expect(weightForUrl("https://api.hyperliquid.xyz/explorer")).toBe(40);
    });
});

describe("retryAfterMs", () => {
    test("parses delta-seconds", () => {
        expect(retryAfterMs("2")).toBe(2000);
    });
    test("returns undefined for missing/garbage", () => {
        expect(retryAfterMs(null)).toBeUndefined();
        expect(retryAfterMs(undefined)).toBeUndefined();
        expect(retryAfterMs("not-a-date")).toBeUndefined();
    });
});
