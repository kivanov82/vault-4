import { formatUnits } from "viem";
import { logger } from "./utils/logger";

// ── Config ──────────────────────────────────────────────────────────────

const VAULT4FUND_ADDRESS = process.env.VAULT4FUND_ADDRESS as `0x${string}` | undefined;
// Hyperscan is HyperEVM's Blockscout-style explorer. Pulling logs from its
// indexed REST API avoids the public-RPC eth_getLogs rate-limit problem
// entirely — one HTTP call per page, server already did the indexing.
const HYPERSCAN_API_BASE = "https://www.hyperscan.com/api/v2";
// Tick cadence — deposits/withdrawals are infrequent (settlement once a day)
// so 10 minutes is plenty.
const REFRESH_INTERVAL_MS = 10 * 60_000;
// Hard cap on pages walked per refresh in case pagination ever loops.
const MAX_PAGES_PER_REFRESH = 50;
// HTTP timeout for a single Hyperscan request.
const FETCH_TIMEOUT_MS = 15_000;

// ── Event topics (keccak256 of the event signature) ─────────────────────

const TOPIC_TO_TYPE: Record<string, ActivityType> = {
    "0xff465791f48805b0254fc0e26cc605e27ef7706d8ee0cf018f8696f58db83679": "DEPOSIT",
    "0x2816dbba0837d8d68f7bcead98695dd98db2cc1cb4066694ead56a12e795c488": "WITHDRAW",
    "0xea6a5867aa6fded974ad8936ccc2cc7e154e2b0a31226d7a62c683af0fbae580": "DEPOSIT_CANCELLED",
    "0x1575adcdc526a67d3f6e771cd9123208ea6b3f48534cbc0ceec405608cc58605": "WITHDRAW_CANCELLED",
    "0xab2daf3c146ca6416cbccd2a86ed2ba995e171ef6319df14a38aef01403a9c96": "INSTANT_WITHDRAW",
};

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
    /** 0 while the first refresh is running, 100 afterwards. */
    scannedPct: number;
}

interface HyperscanLog {
    block_number: number;
    block_timestamp: string; // ISO 8601, e.g. "2026-05-06T14:00:04.000000Z"
    data: string; // 0x-prefixed hex, ABI-encoded non-indexed args
    index: number;
    topics: (string | null)[]; // topics[0] = event sig; topics[1..] = indexed args
    transaction_hash: string;
}

interface HyperscanLogsPage {
    items: HyperscanLog[];
    next_page_params: Record<string, string | number> | null;
}

// ── Service ─────────────────────────────────────────────────────────────

export class Vault4ActivityService {
    private static entries: ActivityEntry[] = [];
    /** Highest block_number we've ingested. Used to short-circuit pagination on tick. */
    private static highestBlockSeen = 0;
    private static initialized = false;
    private static initPromise: Promise<void> | null = null;
    private static interval: NodeJS.Timeout | null = null;

    /** Kick off background indexing. Safe to call multiple times. */
    static start() {
        if (!VAULT4FUND_ADDRESS) {
            logger.warn("Vault4ActivityService: VAULT4FUND_ADDRESS not set, skipping");
            return;
        }
        if (this.initPromise) return;
        this.initPromise = this.refresh({ full: true })
            .then(() => {
                this.initialized = true;
                logger.info("Vault4ActivityService initial refresh complete", {
                    entries: this.entries.length,
                    highestBlock: this.highestBlockSeen,
                });
            })
            .catch((err) => {
                logger.error("Vault4ActivityService initial refresh failed", { message: err?.message });
            });
        if (!this.interval) {
            this.interval = setInterval(() => {
                this.refresh({ full: false }).catch((err) => {
                    logger.warn("Vault4ActivityService tick failed", { message: err?.message });
                });
            }, REFRESH_INTERVAL_MS);
        }
    }

    /**
     * Pull logs from Hyperscan and merge into the in-memory store.
     * - `full: true` walks every page (used on first run).
     * - `full: false` stops as soon as a page contains a block we've already
     *   indexed — incremental tail-fetch.
     */
    private static async refresh({ full }: { full: boolean }) {
        if (!VAULT4FUND_ADDRESS) return;

        const newEntries: ActivityEntry[] = [];
        let nextParams: Record<string, string | number> | null = null;
        let pages = 0;

        do {
            const page = await this.fetchPage(VAULT4FUND_ADDRESS, nextParams);
            if (!page) break;
            pages++;

            let sawKnownBlock = false;
            for (const item of page.items) {
                if (!full && item.block_number <= this.highestBlockSeen) {
                    sawKnownBlock = true;
                    continue;
                }
                const entry = this.decodeLog(item);
                if (entry) newEntries.push(entry);
            }

            // Hyperscan returns logs newest-first. On incremental refresh, once
            // a page contains a block we already have, everything past it is older.
            if (!full && sawKnownBlock) break;

            nextParams = page.next_page_params;
        } while (nextParams && pages < MAX_PAGES_PER_REFRESH);

        if (pages >= MAX_PAGES_PER_REFRESH) {
            logger.warn("Vault4ActivityService refresh hit MAX_PAGES_PER_REFRESH cap", { pages });
        }
        if (newEntries.length === 0) return;

        // Merge — dedupe by (txHash, type, investor) since incremental and
        // full refreshes can overlap on the boundary block.
        const key = (e: ActivityEntry) => `${e.txHash}-${e.type}-${e.investor}`;
        const seen = new Set(this.entries.map(key));
        for (const e of newEntries) {
            if (!seen.has(key(e))) {
                this.entries.push(e);
                if (e.blockNumber > this.highestBlockSeen) this.highestBlockSeen = e.blockNumber;
            }
        }
        this.entries.sort((a, b) => b.blockNumber - a.blockNumber);
    }

    private static async fetchPage(
        address: `0x${string}`,
        nextParams: Record<string, string | number> | null,
    ): Promise<HyperscanLogsPage | null> {
        const url = new URL(`${HYPERSCAN_API_BASE}/addresses/${address}/logs`);
        if (nextParams) {
            for (const [k, v] of Object.entries(nextParams)) {
                url.searchParams.set(k, String(v));
            }
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url.toString(), { signal: ctrl.signal });
            if (!res.ok) {
                logger.warn("Vault4ActivityService Hyperscan non-OK", {
                    url: url.toString(),
                    status: res.status,
                });
                return null;
            }
            return (await res.json()) as HyperscanLogsPage;
        } catch (err: any) {
            logger.warn("Vault4ActivityService Hyperscan fetch failed", {
                url: url.toString(),
                msg: err?.message ?? String(err),
            });
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Decode a Hyperscan log into an ActivityEntry, or return null if the
     * topic isn't one we care about / the payload is malformed.
     *
     * Event layouts (all share `address indexed investor` as topics[1]):
     *   DepositQueued(investor, assets,  index)        → data = [assets, index]
     *   WithdrawQueued(investor, shares, index)        → data = [shares, index]
     *   DepositCancelled(investor, assets,  index)     → data = [assets, index]
     *   WithdrawCancelled(investor, shares, index)     → data = [shares, index]
     *   InstantWithdraw(investor, shares, assets)      → data = [shares, assets]
     */
    private static decodeLog(log: HyperscanLog): ActivityEntry | null {
        const topic0 = log.topics[0];
        if (!topic0) return null;
        const type = TOPIC_TO_TYPE[topic0.toLowerCase()];
        if (!type) return null;

        const investorTopic = log.topics[1];
        if (!investorTopic || investorTopic.length < 66) return null;
        // Address is last 20 bytes of the 32-byte topic.
        const investor = ("0x" + investorTopic.slice(26).toLowerCase()) as `0x${string}`;

        const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
        if (data.length < 128) return null;
        let word0: bigint;
        let word1: bigint;
        try {
            word0 = BigInt("0x" + data.slice(0, 64));
            word1 = BigInt("0x" + data.slice(64, 128));
        } catch {
            return null;
        }

        const ts = Math.floor(new Date(log.block_timestamp).getTime() / 1000);
        if (!Number.isFinite(ts)) return null;

        const entry: ActivityEntry = {
            type,
            investor,
            txHash: log.transaction_hash as `0x${string}`,
            blockNumber: log.block_number,
            timestamp: ts,
        };

        if (type === "INSTANT_WITHDRAW") {
            entry.shares = Number(formatUnits(word0, 6));
            entry.assets = Number(formatUnits(word1, 6));
        } else if (type === "DEPOSIT" || type === "DEPOSIT_CANCELLED") {
            entry.assets = Number(formatUnits(word0, 6));
        } else {
            // WITHDRAW / WITHDRAW_CANCELLED
            entry.shares = Number(formatUnits(word0, 6));
        }
        return entry;
    }

    static list(page = 1, pageSize = 10): ListResponse {
        const safePage = Math.max(1, page);
        const safeSize = Math.min(50, Math.max(1, pageSize));
        const start = (safePage - 1) * safeSize;
        const slice = this.entries.slice(start, start + safeSize);
        return {
            entries: slice,
            total: this.entries.length,
            page: safePage,
            pageSize: safeSize,
            indexedThroughBlock: this.highestBlockSeen,
            scannedPct: this.initialized ? 100 : 0,
        };
    }
}
