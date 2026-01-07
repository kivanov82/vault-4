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


app.listen(port, () => {
    Vault4.init();
});

export default app;
