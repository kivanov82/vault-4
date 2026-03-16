import express from "express";
import { Vault4 } from "./service/Vault4";
import { VaultService } from "./service/vaults/VaultService";
import { VaultContractService } from "./service/settlement/VaultContractService";
import { SettlementScheduler } from "./service/settlement/SettlementScheduler";
import { ArticleService } from "./service/social/ArticleService";
import { paymentMiddleware } from "x402-express";
import { logger } from "./service/utils/logger";

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

app.get("/api/positions", async (req, res) => {
    try {
        const refresh = String(req.query.refresh ?? "false").toLowerCase() === "true";
        const positions = await VaultService.getPlatformPositions({ refresh });
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
        const refresh = String(req.query.refresh ?? "false").toLowerCase() === "true";
        const page = Number(req.query.page ?? 1);
        const pageSize = Number(req.query.pageSize ?? 15);
        const history = await VaultService.getPlatformHistory({
            refresh,
            page,
            pageSize,
        });
        res.json(history);
    } catch (error: any) {
        logger.error("Failed to fetch platform history", {
            message: error?.message,
        });
        res.status(500).json({ error: "Failed to fetch platform history" });
    }
});

app.get("/api/portfolio", async (req, res) => {
    try {
        const refresh = String(req.query.refresh ?? "false").toLowerCase() === "true";
        const portfolio = await VaultService.getPlatformPortfolio({ refresh });
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

app.get("/api/metrics", async (req, res) => {
    try {
        const refresh = String(req.query.refresh ?? "false").toLowerCase() === "true";
        const metrics = await VaultService.getPlatformPerformanceMetrics({ refresh });
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
const x402Wallet = process.env.X402_WALLET ?? process.env.WALLET;
if (x402Wallet) {
    const x402Protected = paymentMiddleware(
        x402Wallet,
        {
            "GET /api/strategy/premium": {
                price: "$0.01",
                network: "base-sepolia",
                description: "VAULT-4 premium strategy: AI vault scores, allocation rationale, and performance history",
            },
        },
        { url: "https://x402.org/facilitator" }
    );

    app.get("/api/strategy/premium", x402Protected, async (req, res) => {
        try {
            const [positions, contractState] = await Promise.all([
                VaultService.getPlatformPositions({ refresh: true }),
                VaultContractService.getContractState(),
            ]);

            const allocations = positions.positions
                .filter((p) => (p.amountUsd ?? 0) > 1)
                .sort((a, b) => (b.amountUsd ?? 0) - (a.amountUsd ?? 0))
                .map((p) => ({
                    vault: p.vaultName ?? p.vaultAddress,
                    vaultAddress: p.vaultAddress,
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
                    epoch: contractState.epoch,
                    sharePrice: contractState.sharePrice,
                    tvlUsd: contractState.totalAssets,
                    deployedToL1: contractState.deployedToL1,
                    idleUsdc: contractState.idleUsdc,
                    pendingDepositsUsd: contractState.pendingDeposits,
                    pendingWithdrawsShares: contractState.pendingWithdraws,
                },
                allocations,
                totalPositions: positions.totalPositions,
                netPnlUsd: positions.netPnlUsd,
                updatedAt: new Date().toISOString(),
            });
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
        const article = await ArticleService.generateArticle(topic);
        if (!article) {
            res.status(400).json({
                error: `Unknown topic: ${topic}`,
                available: ArticleService.getAvailableTopics(),
            });
            return;
        }
        res.json(article);
    } catch (error: any) {
        logger.error("Article generation failed", { message: error?.message });
        res.status(500).json({ error: "Failed to generate article" });
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

app.listen(port, () => {
    Vault4.init();
    SettlementScheduler.start();
});

export default app;
