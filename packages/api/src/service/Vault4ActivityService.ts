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
// Public RPCs cap eth_getLogs ranges; stay well under.
const CHUNK_SIZE = BigInt(4_000);
const ZERO = BigInt(0);
const ONE = BigInt(1);
// Refresh every ~60s so new deposits appear without spamming the RPC.
const REFRESH_INTERVAL_MS = 60_000;

// Bound serial chunk fetching so a fresh boot doesn't hang for minutes.
const MAX_INITIAL_CHUNKS = 200; // ~800k blocks ≈ 9 days. Extends over time as tick() runs.

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

    private static getClient() {
        if (!this.client) {
            this.client = createPublicClient({
                chain: hyperEvm,
                transport: http(HYPEREVM_RPC_URL, { timeout: 30_000 }),
            });
        }
        return this.client;
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
        const latest = await client.getBlockNumber();
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
        const latest = await client.getBlockNumber();

        // 1. New events at the head
        if (latest > this.indexedThroughBlock) {
            await this.scanRange(this.indexedThroughBlock + ONE, latest);
            this.indexedThroughBlock = latest;
        }

        // 2. Extend back-scan up to 5 chunks per tick until we cover 90 days
        if (this.scannedFromBlock > this.targetOldestBlock) {
            const extendBy = BigInt(5) * CHUNK_SIZE;
            const newFrom =
                this.scannedFromBlock > this.targetOldestBlock + extendBy
                    ? this.scannedFromBlock - extendBy
                    : this.targetOldestBlock;
            await this.scanRange(newFrom, this.scannedFromBlock - ONE);
            this.scannedFromBlock = newFrom;
        }
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
        // Sequential to avoid public-RPC rate limits.
        for (const [from, to] of chunks) {
            try {
                const [d, w, i, dc, wc] = await Promise.all([
                    client.getLogs({ address: VAULT4FUND_ADDRESS, event: DEPOSIT_QUEUED, fromBlock: from, toBlock: to }),
                    client.getLogs({ address: VAULT4FUND_ADDRESS, event: WITHDRAW_QUEUED, fromBlock: from, toBlock: to }),
                    client.getLogs({ address: VAULT4FUND_ADDRESS, event: INSTANT_WITHDRAW, fromBlock: from, toBlock: to }),
                    client.getLogs({ address: VAULT4FUND_ADDRESS, event: DEPOSIT_CANCELLED, fromBlock: from, toBlock: to }),
                    client.getLogs({ address: VAULT4FUND_ADDRESS, event: WITHDRAW_CANCELLED, fromBlock: from, toBlock: to }),
                ]);

                const allLogs: Array<{ type: ActivityType; log: any }> = [
                    ...d.map((log) => ({ type: "DEPOSIT" as ActivityType, log })),
                    ...w.map((log) => ({ type: "WITHDRAW" as ActivityType, log })),
                    ...i.map((log) => ({ type: "INSTANT_WITHDRAW" as ActivityType, log })),
                    ...dc.map((log) => ({ type: "DEPOSIT_CANCELLED" as ActivityType, log })),
                    ...wc.map((log) => ({ type: "WITHDRAW_CANCELLED" as ActivityType, log })),
                ];

                if (allLogs.length === 0) continue;

                // Resolve block timestamps (one call per unique block)
                const uniqueBlocks = Array.from(new Set(allLogs.map(({ log }) => log.blockNumber as bigint)));
                const blockTs = new Map<bigint, number>();
                for (const bn of uniqueBlocks) {
                    try {
                        const block = await client.getBlock({ blockNumber: bn });
                        blockTs.set(bn, Number(block.timestamp));
                    } catch (err: any) {
                        logger.warn("getBlock failed", { block: bn.toString(), msg: err?.message });
                    }
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
                logger.warn("Vault4ActivityService scanRange chunk failed", {
                    from: Number(from),
                    to: Number(to),
                    msg: err?.message,
                });
                // Pause briefly on rate-limit errors before continuing.
                if (err?.message?.includes("rate")) {
                    await new Promise((r) => setTimeout(r, 2000));
                }
            }
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
