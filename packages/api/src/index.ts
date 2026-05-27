import express from "express";
import { Vault4 } from "./service/Vault4";
import { VaultService } from "./service/vaults/VaultService";
import { PlatformSnapshotService } from "./service/vaults/PlatformSnapshotService";
import { VaultContractService } from "./service/settlement/VaultContractService";
import { SettlementScheduler } from "./service/settlement/SettlementScheduler";
import { Vault4ActivityService } from "./service/Vault4ActivityService";
import { PremiumSnapshotService } from "./service/PremiumSnapshotService";
import { ArticleService } from "./service/social/ArticleService";
import { XPostService } from "./service/social/XPostService";
import { paymentMiddleware } from "x402-express";
import { logger } from "./service/utils/logger";
import {
    readLedgerHistory,
    readPortfolioSeries,
    readRecentRounds,
    readRoundDetail,
    readVaultTimeline,
} from "./db/TraceService";

const app = express();
const cors = require("cors");
const port = process.env.PORT || 3000;

app.use(express.json())                   //Express
    .use(cors())                            //CORS enabled
    //BigInt  serializer
    .use((req, res, next) => {
        res.json = (data) => {
            return res.send(JSON.stringify(data, (key, value) =>
                typeof value === 'bigint' ? value.toString() : value
            ));
        };
        next();
    });

app.get('/', (req, res) => {
    res.send("Welcome to Vault 4 API");
});

app.get("/health", (req, res) => {
    res.json({ ok: true, service: "vault-4", timestamp: new Date().toISOString() });
});

// ── Discovery: x402 + OpenAPI ───────────────────────────────────────────
// x402 agents probe /.well-known/x402 to find payable endpoints.
app.get("/.well-known/x402", (req, res) => {
    const wallet = process.env.WALLET ?? null;
    res.json({
        version: "0.1",
        name: "VAULT-4 API",
        description: "AI-managed fund-of-vaults on Hyperliquid. Premium endpoint exposes per-vault AI scores, allocation rationale, and PnL breakdown.",
        receiver: wallet,
        facilitator: "https://x402.org/facilitator",
        endpoints: wallet
            ? [
                {
                    path: "/api/strategy/premium",
                    method: "GET",
                    price: "$0.05",
                    network: "base",
                    description: "VAULT-4 premium snapshot: current allocations + ROE, market sentiment overlay (BTC/ETH funding, fear/greed, OI), full candidate vault list, and our top picks. Refreshed every 5 minutes.",
                    schema: {
                        fund: "object",
                        currentAllocations: "array",
                        marketSentiment: "object",
                        candidates: "array",
                        candidateCount: "number",
                        topPicks: "array",
                        topPicksGeneratedAt: "string",
                        updatedAt: "string",
                    },
                },
            ]
            : [],
    });
});

// Minimal OpenAPI 3.0 manifest for indexers / API browsers.
app.get("/openapi.json", (req, res) => {
    res.json({
        openapi: "3.0.0",
        info: {
            title: "VAULT-4 API",
            version: "1.0.0",
            description: "Public read-only data + paid premium strategy endpoint for the VAULT-4 fund-of-vaults on Hyperliquid.",
        },
        servers: [{ url: "https://vault-4-s6qnbk6izq-ew.a.run.app" }],
        paths: {
            "/health": { get: { summary: "Health check", responses: { "200": { description: "OK" } } } },
            "/api/positions": { get: { summary: "Current vault positions" } },
            "/api/portfolio": { get: { summary: "Aggregated portfolio summary" } },
            "/api/portfolio/live": { get: { summary: "Live portfolio (HL clearinghouse)" } },
            "/api/metrics": { get: { summary: "Platform metrics: TVL, PnL %, win rate, max drawdown" } },
            "/api/history": { get: { summary: "Paginated transaction history", parameters: [{ name: "page", in: "query", schema: { type: "integer" } }, { name: "pageSize", in: "query", schema: { type: "integer" } }] } },
            "/api/contract": { get: { summary: "On-chain Vault4Fund contract state" } },
            "/api/activity": { get: { summary: "Recent on-chain deposits/withdrawals (all wallets, ~90d)" } },
            "/api/strategy": { get: { summary: "Free public strategy summary" } },
            "/api/strategy/premium": { get: { summary: "Paid (x402) — current allocations, sentiment overlay, full candidate list, and top picks", "x-x402-price": "$0.05" } },
            "/.well-known/x402": { get: { summary: "x402 payable-endpoints manifest" } },
        },
    });
});

app.get("/api/positions", async (req, res) => {
    try {
        const positions = PlatformSnapshotService.getPositions();
        if (!positions) {
            res.status(503).json({ error: "Snapshot not ready" });
            return;
        }
        res.json(positions);
    } catch (error: any) {
        logger.error("Failed to fetch platform positions", {
            message: error?.message,
        });
        res.status(500).json({ error: "Failed to fetch platform positions" });
    }
});

app.get("/api/history", async (req, res) => {
    try {
        const page = Number(req.query.page ?? 1);
        const pageSize = Number(req.query.pageSize ?? 15);
        const wallet = process.env.WALLET ?? "";
        const dbHistory = await readLedgerHistory({ page, pageSize });
        if (dbHistory && dbHistory.total > 0) {
            const missingNames = dbHistory.entries
                .filter((e) => !e.vaultName)
                .map((e) => e.vaultAddress);
            if (missingNames.length) {
                const resolved = await VaultService.resolveVaultNames(missingNames).catch(
                    () => new Map<string, string>()
                );
                for (const entry of dbHistory.entries) {
                    if (!entry.vaultName) {
                        const name = resolved.get(entry.vaultAddress.toLowerCase());
                        if (name) entry.vaultName = name;
                    }
                }
            }
            res.json({ userAddress: wallet, ...dbHistory });
            return;
        }
        const fallback = PlatformSnapshotService.getHistory(page, pageSize);
        if (!fallback) {
            res.status(503).json({ error: "Snapshot not ready" });
            return;
        }
        res.json(fallback);
    } catch (error: any) {
        logger.error("Failed to fetch platform history", {
            message: error?.message,
        });
        res.status(500).json({ error: "Failed to fetch platform history" });
    }
});

app.get("/api/trace/rounds", async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 20)));
        const rounds = await readRecentRounds(limit);
        res.json({ rounds });
    } catch (error: any) {
        logger.error("Failed to fetch trace rounds", { message: error?.message });
        res.status(500).json({ error: "Failed to fetch trace rounds" });
    }
});

app.get("/api/trace/rounds/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
            res.status(400).json({ error: "Invalid round id" });
            return;
        }
        const detail = await readRoundDetail(id);
        if (!detail) {
            res.status(404).json({ error: "Round not found" });
            return;
        }
        res.json(detail);
    } catch (error: any) {
        logger.error("Failed to fetch round detail", { message: error?.message });
        res.status(500).json({ error: "Failed to fetch round detail" });
    }
});

const CHART_LAUNCH_DATE_MS = Date.parse("2026-01-06T22:17:00+01:00");

app.get("/api/portfolio/chart", async (_req, res) => {
    try {
        const series = await readPortfolioSeries();
        const wallet = process.env.WALLET ?? "";
        if (!series || !series.accountValue.points.length) {
            const portfolio = PlatformSnapshotService.getPortfolio();
            if (!portfolio) {
                res.status(503).json({ error: "Chart data unavailable" });
                return;
            }
            res.json({
                userAddress: wallet,
                source: "hl-snapshot",
                history: portfolio.history,
            });
            return;
        }
        // True total-PnL chart:
        //   totalPnl_at_t = realized_at_t + (vault_equity_at_t − basis_open_at_t)
        // Uses vault-only equity (sum of getUserVaultEquities) NOT HL's
        // `accountValue` which adds the perps wallet — that would create false
        // spikes whenever a rebalance briefly parks cash in the perps wallet.
        // `vault_equity_usd` is only populated for periodic-snapshot rows
        // (going forward). For historical points lacking it, we fall back to
        // accountValue with a note.
        const vaultEqByTs = new Map<number, number>();
        for (const p of series.vaultEquity.points)
            vaultEqByTs.set(p.timestamp, p.value);
        const accByTs = new Map<number, number>();
        for (const p of series.accountValue.points)
            accByTs.set(p.timestamp, p.value);
        const realizedByTs = new Map<number, number>();
        for (const p of series.ourRealizedPnl.points)
            realizedByTs.set(p.timestamp, p.value);
        const basisByTs = new Map<number, number>();
        for (const p of series.ourBasisOpen.points)
            basisByTs.set(p.timestamp, p.value);
        const allTs = [
            ...new Set([
                ...vaultEqByTs.keys(),
                ...accByTs.keys(),
                ...realizedByTs.keys(),
                ...basisByTs.keys(),
            ]),
        ]
            .filter((t) => t >= CHART_LAUNCH_DATE_MS)
            .sort((a, b) => a - b);
        let lastRealized = 0;
        let lastBasis = 0;
        let lastAcc = 0;
        let lastVaultEq: number | null = null;
        const pnlPoints: { timestamp: number; value: number }[] = [];
        const accPoints: { timestamp: number; value: number }[] = [];
        for (const ts of allTs) {
            if (realizedByTs.has(ts)) lastRealized = realizedByTs.get(ts) as number;
            if (basisByTs.has(ts)) lastBasis = basisByTs.get(ts) as number;
            if (accByTs.has(ts)) lastAcc = accByTs.get(ts) as number;
            if (vaultEqByTs.has(ts)) lastVaultEq = vaultEqByTs.get(ts) as number;
            // Prefer vault-only equity; fall back to accountValue (perps+vaults).
            const equity = lastVaultEq ?? lastAcc;
            const totalPnl = lastRealized + (equity - lastBasis);
            pnlPoints.push({ timestamp: ts, value: totalPnl });
            accPoints.push({ timestamp: ts, value: equity });
        }
        res.json({
            userAddress: wallet,
            source: "portfolio_series",
            history: {
                pnl: { points: pnlPoints },
                accountValue: { points: accPoints },
                ourRealizedPnl: {
                    points: series.ourRealizedPnl.points.filter(
                        (p) => p.timestamp >= CHART_LAUNCH_DATE_MS
                    ),
                },
                ourBasisOpen: {
                    points: series.ourBasisOpen.points.filter(
                        (p) => p.timestamp >= CHART_LAUNCH_DATE_MS
                    ),
                },
            },
        });
    } catch (error: any) {
        logger.error("Failed to fetch portfolio chart", { message: error?.message });
        res.status(500).json({ error: "Failed to fetch portfolio chart" });
    }
});

app.get("/api/trace/positions/:vaultAddress", async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 100)));
        const timeline = await readVaultTimeline(req.params.vaultAddress, limit);
        res.json({ vaultAddress: req.params.vaultAddress, events: timeline });
    } catch (error: any) {
        logger.error("Failed to fetch vault timeline", { message: error?.message });
        res.status(500).json({ error: "Failed to fetch vault timeline" });
    }
});

app.get("/api/portfolio", async (req, res) => {
    try {
        const portfolio = PlatformSnapshotService.getPortfolio();
        if (!portfolio) {
            res.status(404).json({ error: "Portfolio not found" });
            return;
        }
        res.json(portfolio);
    } catch (error: any) {
        logger.error("Failed to fetch platform portfolio", {
            message: error?.message,
        });
        res.status(500).json({ error: "Failed to fetch platform portfolio" });
    }
});

app.get("/api/portfolio/live", async (req, res) => {
    try {
        const portfolio = await VaultService.getPlatformPortfolio({ refresh: true });
        if (!portfolio) {
            res.status(404).json({ error: "Portfolio not found" });
            return;
        }
        res.json(portfolio);
    } catch (error: any) {
        logger.error("Failed to fetch live portfolio", {
            message: error?.message,
        });
        res.status(500).json({ error: "Failed to fetch live portfolio" });
    }
});

app.get("/api/metrics", async (req, res) => {
    try {
        const metrics = PlatformSnapshotService.getMetrics();
        if (!metrics) {
            res.status(503).json({ error: "Snapshot not ready" });
            return;
        }
        res.json(metrics);
    } catch (error: any) {
        logger.error("Failed to fetch platform metrics", {
            message: error?.message,
        });
        res.status(500).json({ error: "Failed to fetch platform metrics" });
    }
});


// Public strategy endpoint — current allocations and fund state
app.get("/api/strategy", async (req, res) => {
    try {
        const [positions, contractState] = await Promise.all([
            VaultService.getPlatformPositions(),
            VaultContractService.getContractState(),
        ]);

        const allocations = positions.positions
            .filter((p) => (p.amountUsd ?? 0) > 1) // filter dust
            .sort((a, b) => (b.amountUsd ?? 0) - (a.amountUsd ?? 0))
            .map((p) => ({
                vault: p.vaultName ?? p.vaultAddress,
                allocationUsd: p.amountUsd,
                allocationPct: p.sizePct,
                pnlUsd: p.pnlUsd,
                roePct: p.roePct,
            }));

        res.json({
            fund: {
                name: "VAULT-4",
                contract: process.env.VAULT4FUND_ADDRESS,
                chain: "HyperEVM (999)",
                shareToken: "V4FUND",
                epoch: contractState.epoch,
                sharePrice: contractState.sharePrice,
                tvlUsd: contractState.totalAssets,
                deployedToL1: contractState.deployedToL1,
                pendingDepositsUsd: contractState.pendingDeposits,
                pendingWithdrawsShares: contractState.pendingWithdraws,
                settlementSchedule: "Daily 14:00 UTC (3PM CET)",
            },
            allocations,
            activeVaults: allocations.length,
            updatedAt: new Date().toISOString(),
        });
    } catch (error: any) {
        logger.error("Failed to build strategy response", { message: error?.message });
        res.status(500).json({ error: "Failed to fetch strategy data" });
    }
});

// x402-gated premium endpoint — AI scoring details + full allocation breakdown
const x402Wallet = process.env.WALLET;
if (x402Wallet) {
    const x402Protected = paymentMiddleware(
        x402Wallet,
        {
            "GET /api/strategy/premium": {
                price: "$0.05",
                network: "base",
                config: {
                    description: "VAULT-4 premium snapshot: current allocations, market sentiment overlay, full candidate vault list, and ranked top picks. Refreshed every 5 minutes.",
                    outputSchema: {
                        fund: "object",
                        currentAllocations: "array",
                        marketSentiment: "object",
                        candidates: "array",
                        candidateCount: "number",
                        topPicks: "array",
                        topPicksGeneratedAt: "string",
                        updatedAt: "string",
                    },
                },
            },
        },
        { url: "https://x402.org/facilitator" }
    );

    app.get("/api/strategy/premium", x402Protected, async (req, res) => {
        try {
            const payload = await PremiumSnapshotService.get();
            res.json(payload);
        } catch (error: any) {
            logger.error("Failed to build premium strategy", { message: error?.message });
            res.status(500).json({ error: "Failed to fetch premium strategy data" });
        }
    });
    logger.info("x402 premium endpoint enabled", { wallet: x402Wallet });
}

// Manual settlement trigger (dry-run by default, ?execute=true to run)
app.post("/api/settle", async (req, res) => {
    try {
        const dryRun = String(req.query.execute ?? "false").toLowerCase() !== "true";
        logger.info("Manual settlement triggered", { dryRun });
        await VaultContractService.runSettlement({ dryRun });
        const state = await VaultContractService.getContractState();
        res.json({ ok: true, dryRun, contractState: state });
    } catch (error: any) {
        logger.error("Settlement failed", { message: error?.message });
        res.status(500).json({ error: error?.message ?? "Settlement failed" });
    }
});

// Draft article for X Articles
app.get("/api/draft-article", async (req, res) => {
    try {
        const topic = String(req.query.topic ?? "");
        if (!topic) {
            res.json({ topics: ArticleService.getAvailableTopics() });
            return;
        }
        if (!ArticleService.getAvailableTopics().includes(topic)) {
            res.status(400).json({
                error: `Unknown topic: ${topic}`,
                available: ArticleService.getAvailableTopics(),
            });
            return;
        }
        const article = await ArticleService.generateArticle(topic);
        if (!article) {
            res.status(500).json({ error: "Article generation failed — check API key" });
            return;
        }
        res.json(article);
    } catch (error: any) {
        logger.error("Article generation failed", { message: error?.message });
        res.status(500).json({ error: "Failed to generate article" });
    }
});

// Test X post (generates tweet preview, ?post=true to actually publish)
app.post("/api/x-post", async (req, res) => {
    try {
        const doPost = String(req.query.post ?? "false").toLowerCase() === "true";
        const [positions, contractState] = await Promise.all([
            VaultService.getPlatformPositions({ refresh: true }),
            VaultContractService.getContractState(),
        ]);
        const allocations = positions.positions
            .filter((p) => (p.amountUsd ?? 0) > 1)
            .sort((a, b) => (b.amountUsd ?? 0) - (a.amountUsd ?? 0))
            .map((p) => ({
                vault: p.vaultName ?? p.vaultAddress,
                allocationUsd: p.amountUsd,
                roePct: p.roePct,
            }));

        const context = {
            epoch: contractState.epoch,
            totalAssets: contractState.totalAssets,
            sharePrice: contractState.sharePrice,
            prevSharePrice: contractState.sharePrice, // no change for test
            deployedToL1: contractState.deployedToL1,
            depositsProcessed: 0,
            withdrawsProcessed: 0,
            allocations,
        };

        if (doPost) {
            await XPostService.postSettlementUpdate(context);
            res.json({ ok: true, posted: true, context });
        } else {
            res.json({ ok: true, posted: false, preview: context, hint: "Add ?post=true to publish" });
        }
    } catch (error: any) {
        logger.error("X post test failed", { message: error?.message });
        res.status(500).json({ error: error?.message ?? "X post failed" });
    }
});

// Contract state view
app.get("/api/contract", async (req, res) => {
    try {
        const state = await VaultContractService.getContractState();
        res.json(state);
    } catch (error: any) {
        logger.error("Failed to read contract state", { message: error?.message });
        res.status(500).json({ error: error?.message ?? "Failed to read contract state" });
    }
});

// Recent on-chain activity (deposits, withdrawals — all wallets)
app.get("/api/activity", (req, res) => {
    Vault4ActivityService.start(); // lazy: kick off background indexer on first hit
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 10);
    res.json(Vault4ActivityService.list(page, pageSize));
});

app.listen(port, () => {
    Vault4.init();
    SettlementScheduler.start();
    // Vault4ActivityService.start() is invoked lazily on first /api/activity hit
    // to keep cold-start memory low.
});

export default app;
