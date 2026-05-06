import { createPublicClient, defineChain, formatUnits, http, parseAbiItem } from "viem";
import { logger } from "./utils/logger";

// ── Config ──────────────────────────────────────────────────────────────

const VAULT4FUND_ADDRESS = process.env.VAULT4FUND_ADDRESS as `0x${string}` | undefined;
const HYPEREVM_RPC_URL = process.env.HYPEREVM_RPC_URL ?? "https://rpc.hyperliquid.xyz/evm";

const hyperEvm = defineChain({
    id: 999,
    name: "HyperEVM",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [HYPEREVM_RPC_URL] } },
});

// HyperEVM produces a small block ~every second.
const NINETY_DAYS_BLOCKS = BigInt(90 * 24 * 60 * 60);
// Hyperliquid RPC caps eth_getLogs at 1000 blocks per request.
const CHUNK_SIZE = BigInt(999);
const ZERO = BigInt(0);
const ONE = BigInt(1);
// Tick interval — how often we poll the RPC for new events + extend the
// historical back-scan. Deposits/withdrawals are infrequent (settlement once
// a day) so a 10-minute cadence is plenty without burning RPC quota.
const REFRESH_INTERVAL_MS = Number(process.env.ACTIVITY_TICK_MS ?? 10 * 60_000);
// Minimum gap between consecutive RPC calls. Public Hyperliquid RPC enforces
// a strict request-rate cap shared with VaultService/HyperliquidConnector hitting
// the same host — 750ms wasn't enough in practice (saw "Request exceeds defined
// limit" even after 14s of retry backoff). 1500ms ≈ 0.67 r/s leaves headroom for
// the other services on this IP.
const RPC_MIN_GAP_MS = Number(process.env.HYPEREVM_RPC_GAP_MS ?? 1500);
// Cap pending retry queue so a sustained outage doesn't grow it unbounded.
const MAX_PENDING_RETRIES = 100;
// Per-tick budget for replaying failed chunks before extending the back-scan.
const RETRIES_PER_TICK = 4;

// Bound serial chunk fetching so a fresh boot doesn't OOM the container.
// Each tick extends the window by a few more chunks. Full 90d coverage builds up over hours.
// 30 chunks × 999 blocks ≈ 8 hours initial coverage. Extends on tick.
const MAX_INITIAL_CHUNKS = 30;

// ── Events ──────────────────────────────────────────────────────────────

const DEPOSIT_QUEUED = parseAbiItem(
    "event DepositQueued(address indexed investor, uint256 assets, uint256 index)",
);
const WITHDRAW_QUEUED = parseAbiItem(
    "event WithdrawQueued(address indexed investor, uint256 shares, uint256 index)",
);
const DEPOSIT_CANCELLED = parseAbiItem(
    "event DepositCancelled(address indexed investor, uint256 assets, uint256 index)",
);
const WITHDRAW_CANCELLED = parseAbiItem(
    "event WithdrawCancelled(address indexed investor, uint256 shares, uint256 index)",
);
const INSTANT_WITHDRAW = parseAbiItem(
    "event InstantWithdraw(address indexed investor, uint256 shares, uint256 assets)",
);

// ── Types ───────────────────────────────────────────────────────────────

export type ActivityType =
    | "DEPOSIT"
    | "WITHDRAW"
    | "INSTANT_WITHDRAW"
    | "DEPOSIT_CANCELLED"
    | "WITHDRAW_CANCELLED";

export interface ActivityEntry {
    type: ActivityType;
    investor: `0x${string}`;
    /** USDC amount (assets) — present for events that emit assets directly. */
    assets?: number;
    /** Share count — present for events that emit shares. */
    shares?: number;
    txHash: `0x${string}`;
    blockNumber: number;
    /** Unix seconds. */
    timestamp: number;
}

interface ListResponse {
    entries: ActivityEntry[];
    total: number;
    page: number;
    pageSize: number;
    /** Block number through which we have indexed. */
    indexedThroughBlock: number;
    /** Approx % of the 90-day window we've actually scanned (0–100). */
    scannedPct: number;
}

// ── Service ─────────────────────────────────────────────────────────────

export class Vault4ActivityService {
    private static client: ReturnType<typeof createPublicClient> | null = null;
    private static entries: ActivityEntry[] = [];
    /** Newest block we have ingested, inclusive. */
    private static indexedThroughBlock = ZERO;
    /** Oldest block we have scanned. We extend backwards on each tick. */
    private static scannedFromBlock = ZERO;
    /** Target oldest block (90 days back). Extending backwards stops here. */
    private static targetOldestBlock = ZERO;
    private static initPromise: Promise<void> | null = null;
    private static interval: NodeJS.Timeout | null = null;
    /**
     * Block ranges where at least one RPC call inside the chunk returned null
     * (rate-limited past all retries). Replayed at the start of the next tick
     * so events aren't permanently dropped when the public RPC throttles us.
     */
    private static pendingRetries: Array<[bigint, bigint]> = [];

    private static getClient() {
        if (!this.client) {
            this.client = createPublicClient({
                chain: hyperEvm,
                transport: http(HYPEREVM_RPC_URL, { timeout: 30_000 }),
            });
        }
        return this.client;
    }

    /**
     * Throttled, retry-on-rate-limit RPC wrapper.
     * - Enforces a global minimum gap between any two RPC calls.
     * - On "Request exceeds defined limit" / "rate limited" / 429 / 503, sleeps
     *   exponentially (2s, 4s, 8s) up to 4 attempts before giving up.
     */
    private static lastRpcCallAt = 0;
    private static async rpcCall<T>(fn: () => Promise<T>): Promise<T | null> {
        const attempts = 4;
        for (let i = 0; i < attempts; i++) {
            const sinceLast = Date.now() - this.lastRpcCallAt;
            if (sinceLast < RPC_MIN_GAP_MS) {
                await new Promise((r) => setTimeout(r, RPC_MIN_GAP_MS - sinceLast));
            }
            this.lastRpcCallAt = Date.now();
            try {
                return await fn();
            } catch (err: any) {
                const msg = err?.message ?? String(err);
                const retryable =
                    msg.includes("Request exceeds defined limit") ||
                    msg.includes("rate limited") ||
                    msg.includes("429") ||
                    msg.includes("502") ||
                    msg.includes("503") ||
                    msg.includes("ETIMEDOUT") ||
                    msg.includes("ECONNRESET");
                if (i < attempts - 1 && retryable) {
                    const backoff = 2000 * Math.pow(2, i); // 2s, 4s, 8s
                    await new Promise((r) => setTimeout(r, backoff));
                    continue;
                }
                logger.warn("Vault4ActivityService rpcCall failed", { msg, attempt: i + 1 });
                return null;
            }
        }
        return null;
    }

    /** Kick off background indexing. Safe to call multiple times. */
    static start() {
        if (!VAULT4FUND_ADDRESS) {
            logger.warn("Vault4ActivityService: VAULT4FUND_ADDRESS not set, skipping");
            return;
        }
        if (this.initPromise) return;
        this.initPromise = this.runInitialScan().catch((err) => {
            logger.error("Vault4ActivityService initial scan failed", { message: err?.message });
        });
        if (!this.interval) {
            this.interval = setInterval(() => {
                this.tick().catch((err) => {
                    logger.warn("Vault4ActivityService tick failed", { message: err?.message });
                });
            }, REFRESH_INTERVAL_MS);
        }
    }

    /** Bound initial scan from latest block backwards. */
    private static async runInitialScan() {
        if (!VAULT4FUND_ADDRESS) return;
        const client = this.getClient();
        const latest = await this.rpcCall(() => client.getBlockNumber());
        if (latest === null) return;
        this.indexedThroughBlock = latest;
        this.targetOldestBlock = latest > NINETY_DAYS_BLOCKS ? latest - NINETY_DAYS_BLOCKS : ZERO;

        const initialOldest =
            latest > BigInt(MAX_INITIAL_CHUNKS) * CHUNK_SIZE
                ? latest - BigInt(MAX_INITIAL_CHUNKS) * CHUNK_SIZE
                : this.targetOldestBlock;

        await this.scanRange(initialOldest, latest);
        this.scannedFromBlock = initialOldest;

        logger.info("Vault4ActivityService initial scan complete", {
            entries: this.entries.length,
            from: Number(initialOldest),
            to: Number(latest),
        });
    }

    /**
     * Periodic tick: pull new events at the head, AND extend the back-scan
     * by a few chunks so the 90-day window fills in over time.
     */
    private static async tick() {
        if (!VAULT4FUND_ADDRESS) return;
        const client = this.getClient();
        const latest = await this.rpcCall(() => client.getBlockNumber());
        if (latest === null) return;

        // 0. Replay chunks that hit the rate limit on a previous pass before
        //    we expand the indexed window — otherwise rate-limited holes get
        //    stranded behind scannedFromBlock and never re-scanned.
        if (this.pendingRetries.length > 0) {
            const toRetry = this.pendingRetries.splice(0, RETRIES_PER_TICK);
            for (const [from, to] of toRetry) {
                await this.scanRange(from, to);
            }
        }

        // 1. New events at the head
        if (latest > this.indexedThroughBlock) {
            await this.scanRange(this.indexedThroughBlock + ONE, latest);
            this.indexedThroughBlock = latest;
        }

        // 2. Extend back-scan up to 2 chunks per tick (~2k blocks) until we
        //    cover 90 days. Slow on purpose — each chunk is 5+ RPC calls and
        //    the public Hyperliquid RPC is shared with the rest of the API.
        if (this.scannedFromBlock > this.targetOldestBlock) {
            const extendBy = BigInt(2) * CHUNK_SIZE;
            const newFrom =
                this.scannedFromBlock > this.targetOldestBlock + extendBy
                    ? this.scannedFromBlock - extendBy
                    : this.targetOldestBlock;
            await this.scanRange(newFrom, this.scannedFromBlock - ONE);
            this.scannedFromBlock = newFrom;
        }
    }

    private static queueRetry(from: bigint, to: bigint) {
        if (this.pendingRetries.length >= MAX_PENDING_RETRIES) return;
        this.pendingRetries.push([from, to]);
    }

    private static async scanRange(fromBlock: bigint, toBlock: bigint) {
        if (!VAULT4FUND_ADDRESS) return;
        const client = this.getClient();

        const chunks: Array<[bigint, bigint]> = [];
        let cursor = fromBlock;
        while (cursor <= toBlock) {
            const end = cursor + CHUNK_SIZE - ONE > toBlock ? toBlock : cursor + CHUNK_SIZE - ONE;
            chunks.push([cursor, end]);
            cursor = end + ONE;
        }

        const newEntries: ActivityEntry[] = [];
        // All RPC calls are serialized + spaced to stay under the public RPC's
        // request-rate cap (separate from the 1000-block range cap).
        for (const [from, to] of chunks) {
            // If any RPC inside this chunk gives up after retries, queue the
            // whole chunk to be replayed next tick — otherwise dropped events
            // never come back (the back-scan only moves outward).
            let chunkOk = true;
            try {
                const events = [
                    { type: "DEPOSIT" as ActivityType, abi: DEPOSIT_QUEUED },
                    { type: "WITHDRAW" as ActivityType, abi: WITHDRAW_QUEUED },
                    { type: "INSTANT_WITHDRAW" as ActivityType, abi: INSTANT_WITHDRAW },
                    { type: "DEPOSIT_CANCELLED" as ActivityType, abi: DEPOSIT_CANCELLED },
                    { type: "WITHDRAW_CANCELLED" as ActivityType, abi: WITHDRAW_CANCELLED },
                ];
                const allLogs: Array<{ type: ActivityType; log: any }> = [];
                for (const { type, abi } of events) {
                    const logs = await this.rpcCall(() =>
                        client.getLogs({ address: VAULT4FUND_ADDRESS!, event: abi, fromBlock: from, toBlock: to }),
                    );
                    if (logs === null) chunkOk = false;
                    else for (const log of logs) allLogs.push({ type, log });
                }

                if (allLogs.length === 0) {
                    if (!chunkOk) this.queueRetry(from, to);
                    continue;
                }

                // Resolve block timestamps (one call per unique block, serialized)
                const uniqueBlocks = Array.from(new Set(allLogs.map(({ log }) => log.blockNumber as bigint)));
                const blockTs = new Map<bigint, number>();
                for (const bn of uniqueBlocks) {
                    const block = await this.rpcCall(() => client.getBlock({ blockNumber: bn }));
                    if (block) blockTs.set(bn, Number(block.timestamp));
                    else chunkOk = false;
                }

                for (const { type, log } of allLogs) {
                    const args = log.args as any;
                    const ts = blockTs.get(log.blockNumber as bigint);
                    if (ts === undefined) continue;
                    const entry: ActivityEntry = {
                        type,
                        investor: args.investor,
                        txHash: log.transactionHash,
                        blockNumber: Number(log.blockNumber),
                        timestamp: ts,
                    };
                    if (args.assets !== undefined) {
                        entry.assets = Number(formatUnits(args.assets as bigint, 6));
                    }
                    if (args.shares !== undefined) {
                        entry.shares = Number(formatUnits(args.shares as bigint, 6));
                    }
                    newEntries.push(entry);
                }
            } catch (err: any) {
                chunkOk = false;
                logger.warn("Vault4ActivityService scanRange chunk failed", {
                    from: Number(from),
                    to: Number(to),
                    msg: err?.message,
                });
                if (err?.message?.includes("rate")) {
                    await new Promise((r) => setTimeout(r, 2000));
                }
            }
            if (!chunkOk) this.queueRetry(from, to);
        }

        if (newEntries.length === 0) return;

        // Merge — dedupe by (txHash, type, investor) since chunks may overlap on retries
        const key = (e: ActivityEntry) => `${e.txHash}-${e.type}-${e.investor}`;
        const seen = new Set(this.entries.map(key));
        for (const e of newEntries) {
            if (!seen.has(key(e))) this.entries.push(e);
        }
        this.entries.sort((a, b) => b.blockNumber - a.blockNumber);
    }

    static list(page = 1, pageSize = 10): ListResponse {
        const safePage = Math.max(1, page);
        const safeSize = Math.min(50, Math.max(1, pageSize));
        const start = (safePage - 1) * safeSize;
        const slice = this.entries.slice(start, start + safeSize);
        const totalRangeBlocks = this.indexedThroughBlock - this.targetOldestBlock;
        const scannedBlocks = this.indexedThroughBlock - this.scannedFromBlock;
        const scannedPct = totalRangeBlocks > ZERO
            ? Math.min(100, Number((scannedBlocks * BigInt(100)) / totalRangeBlocks))
            : 0;
        return {
            entries: slice,
            total: this.entries.length,
            page: safePage,
            pageSize: safeSize,
            indexedThroughBlock: Number(this.indexedThroughBlock),
            scannedPct,
        };
    }
}
