import { logger } from "../utils/logger";

/**
 * Weighted token-bucket rate limiter for outbound Hyperliquid REST traffic.
 *
 * Hyperliquid enforces an aggregated budget of 1200 request-weight per minute
 * per IP across ALL REST endpoints (info + exchange). Most info requests weigh
 * 20, a handful weigh 2, `userRole` weighs 60. Previously each fan-out site
 * (5-min platform snapshot refresh, rebalance candidate discovery, settlement,
 * X-post builder) limited its own concurrency in isolation, so collectively
 * they overshot the budget and HL replied 429 — which, mid-round, silently
 * turned an equity lookup into an empty list and skipped a stop-loss exit.
 *
 * This limiter is a single global chokepoint shared by every HL caller (both
 * the @nktkas/hyperliquid SDK transports via their onRequest hook, and the
 * raw axios `/info` posts). Requests acquire `weight` tokens before firing;
 * tokens refill at a sustained rate kept safely below HL's ceiling, with a
 * small burst capacity for latency-sensitive bursts (e.g. a round's exit
 * equity checks). A 429 from anywhere drains the bucket and pauses dispatch
 * for a cooldown (honoring Retry-After), backing the whole fleet off at once.
 *
 * Higher-`priority` waiters (withdrawals, deposits, round equity checks) jump
 * ahead of background polling so execution is never starved behind a refresh.
 */

export interface RateLimiterOptions {
    /** Sustained budget in request-weight per minute. Keep below HL's 1200. */
    weightPerMin: number;
    /** Max token bucket capacity — bounds instantaneous bursts. */
    burst: number;
    /** Base cooldown (ms) applied to the whole fleet on a 429. */
    penaltyMs: number;
}

interface Waiter {
    weight: number;
    priority: number;
    seq: number;
    resolve: () => void;
}

export class RateLimiter {
    private readonly capacity: number;
    private readonly refillPerMs: number;
    private readonly penaltyMs: number;

    private tokens: number;
    private lastRefillMs: number;
    private pausedUntilMs = 0;
    private seqCounter = 0;
    private readonly queue: Waiter[] = [];
    private pumpTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(opts: RateLimiterOptions) {
        this.capacity = Math.max(1, opts.burst);
        this.refillPerMs = Math.max(opts.weightPerMin, 1) / 60000;
        this.penaltyMs = Math.max(0, opts.penaltyMs);
        this.tokens = this.capacity;
        this.lastRefillMs = Date.now();
    }

    /**
     * Block until `weight` tokens are available, then consume them. Resolves
     * when the caller is cleared to send. Higher priority is served first.
     */
    acquire(weight = 20, priority = 0): Promise<void> {
        return new Promise<void>((resolve) => {
            this.queue.push({
                weight: Math.max(1, weight),
                priority,
                seq: this.seqCounter++,
                resolve,
            });
            this.pump();
        });
    }

    /** Run `fn` once the bucket clears. Thin wrapper over {@link acquire}. */
    async schedule<T>(
        fn: () => Promise<T>,
        opts: { weight?: number; priority?: number } = {}
    ): Promise<T> {
        await this.acquire(opts.weight ?? 20, opts.priority ?? 0);
        return fn();
    }

    /**
     * React to a 429 (or other rate-limit signal) from any HL response. Drains
     * the bucket and pauses dispatch for `max(penaltyMs, retryAfterMs)` so the
     * entire fleet recovers together instead of hammering through the cooldown.
     */
    penalize(retryAfterMs?: number): void {
        const now = Date.now();
        const pause = Math.max(this.penaltyMs, retryAfterMs ?? 0);
        this.pausedUntilMs = Math.max(this.pausedUntilMs, now + pause);
        this.tokens = 0;
        this.lastRefillMs = now;
        logger.warn("HL rate limiter backing off after 429", {
            pauseMs: pause,
            queued: this.queue.length,
        });
        this.scheduleWake(pause);
    }

    /** Snapshot for observability/logging. */
    stats(): { tokens: number; queued: number; pausedMs: number } {
        return {
            tokens: Math.floor(this.tokens),
            queued: this.queue.length,
            pausedMs: Math.max(0, this.pausedUntilMs - Date.now()),
        };
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefillMs;
        if (elapsed <= 0) return;
        this.tokens = Math.min(
            this.capacity,
            this.tokens + elapsed * this.refillPerMs
        );
        this.lastRefillMs = now;
    }

    private pump(): void {
        if (this.queue.length === 0) return;

        const now = Date.now();
        if (now < this.pausedUntilMs) {
            this.scheduleWake(this.pausedUntilMs - now);
            return;
        }
        this.refill();

        // Highest priority first; FIFO within a priority for fairness.
        this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);

        while (this.queue.length > 0) {
            const head = this.queue[0];
            if (this.tokens < head.weight) {
                // Wake exactly when enough tokens will have accrued for the head.
                this.scheduleWake((head.weight - this.tokens) / this.refillPerMs);
                return;
            }
            this.tokens -= head.weight;
            this.queue.shift();
            head.resolve();
        }
    }

    private scheduleWake(delayMs: number): void {
        if (this.pumpTimer) return;
        const delay = Math.max(5, Math.ceil(delayMs));
        this.pumpTimer = setTimeout(() => {
            this.pumpTimer = null;
            this.pump();
        }, delay);
        // Never keep the process alive solely for a pending pump.
        if (typeof this.pumpTimer.unref === "function") this.pumpTimer.unref();
    }
}

const numEnv = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Process-wide limiter for all Hyperliquid REST traffic. Defaults target ~80%
 * of HL's 1200 weight/min ceiling, leaving headroom so a worst-case aligned
 * minute (burst + a full minute of refill) still stays under the hard limit.
 * Tunable via env without a redeploy of the limiter logic.
 */
export const hlLimiter = new RateLimiter({
    weightPerMin: numEnv("HL_RATE_WEIGHT_PER_MIN", 960),
    burst: numEnv("HL_RATE_BURST", 120),
    penaltyMs: numEnv("HL_RATE_PENALTY_MS", 10000),
});

/** Request-weight by HL endpoint. Info defaults to the common case (20). */
export function weightForUrl(url: string): number {
    if (url.endsWith("/exchange")) return 1;
    if (url.endsWith("/explorer")) return 40;
    return 20; // /info and anything else: assume the common weight-20 case
}

/** Priority lanes: execution-critical traffic jumps ahead of background polling. */
export const HL_PRIORITY = {
    BACKGROUND: 0,
    READ: 5,
    EXECUTION: 10,
} as const;

/** Pull a Retry-After header (seconds or HTTP-date) into milliseconds, if present. */
export function retryAfterMs(headerValue: string | null | undefined): number | undefined {
    if (!headerValue) return undefined;
    const secs = Number(headerValue);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(headerValue);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    return undefined;
}
