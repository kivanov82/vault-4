import express from "express";
import { Vault4 } from "./service/Vault4";
import { VaultService } from "./service/vaults/VaultService";
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

app.get("/api/vaults/:vaultAddress/metrics", async (req, res) => {
    try {
        const vaultAddress = String(req.params.vaultAddress);
        const metrics = await VaultService.getVaultMetrics(vaultAddress);
        if (!metrics) {
            res.status(404).json({ error: "Vault not found" });
            return;
        }
        res.json(metrics);
    } catch (error: any) {
        logger.error("Failed to fetch vault metrics", { message: error?.message });
        res.status(500).json({ error: "Failed to fetch vault metrics" });
    }
});

app.get("/api/vaults/:vaultAddress/history", async (req, res) => {
    try {
        const vaultAddress = String(req.params.vaultAddress);
        const history = await VaultService.getVaultHistory(vaultAddress);
        if (!history) {
            res.status(404).json({ error: "Vault not found" });
            return;
        }
        res.json(history);
    } catch (error: any) {
        logger.error("Failed to fetch vault history", { message: error?.message });
        res.status(500).json({ error: "Failed to fetch vault history" });
    }
});

app.get("/api/users/:userAddress/vaults", async (req, res) => {
    try {
        const userAddress = String(req.params.userAddress);
        const refresh = String(req.query.refresh ?? "false").toLowerCase() === "true";
        const includeHistory =
            String(req.query.includeHistory ?? "false").toLowerCase() === "true";
        const vaults = await VaultService.getUserVaults(userAddress, {
            refresh,
            includeHistory,
        });
        res.json(vaults);
    } catch (error: any) {
        logger.error("Failed to fetch user vaults", { message: error?.message });
        res.status(500).json({ error: "Failed to fetch user vaults" });
    }
});

app.get("/api/users/:userAddress/vaults/:vaultAddress/history", async (req, res) => {
    try {
        const userAddress = String(req.params.userAddress);
        const vaultAddress = String(req.params.vaultAddress);
        const history = await VaultService.getUserVaultHistory(userAddress, vaultAddress);
        if (!history) {
            res.status(404).json({ error: "User vault history not found" });
            return;
        }
        res.json(history);
    } catch (error: any) {
        logger.error("Failed to fetch user vault history", { message: error?.message });
        res.status(500).json({ error: "Failed to fetch user vault history" });
    }
});

app.get("/api/users/:userAddress/portfolio", async (req, res) => {
    try {
        const userAddress = String(req.params.userAddress);
        const refresh = String(req.query.refresh ?? "false").toLowerCase() === "true";
        const portfolio = await VaultService.getUserPortfolio(userAddress, { refresh });
        if (!portfolio) {
            res.status(404).json({ error: "Portfolio not found" });
            return;
        }
        res.json(portfolio);
    } catch (error: any) {
        logger.error("Failed to fetch user portfolio", { message: error?.message });
        res.status(500).json({ error: "Failed to fetch user portfolio" });
    }
});


app.listen(port, () => {
    Vault4.init();
});

export default app;
