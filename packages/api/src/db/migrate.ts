import fs from "fs";
import path from "path";
import type { PoolClient } from "pg";
import { getPool } from "./pool";
import { logger } from "../service/utils/logger";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "..", "migrations");

export async function runMigrations(): Promise<void> {
    const pool = getPool();
    if (!pool) {
        logger.warn("Skipping migrations — no DB pool configured");
        return;
    }
    let client: PoolClient;
    try {
        client = await pool.connect();
    } catch (error: any) {
        logger.warn("Migration: failed to acquire client", { message: error?.message });
        return;
    }
    try {
        await client.query(
            `CREATE TABLE IF NOT EXISTS _migrations (
                name TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )`
        );
        const files = fs
            .readdirSync(MIGRATIONS_DIR)
            .filter((f) => f.endsWith(".sql"))
            .sort();
        // Advisory lock so concurrent Cloud Run replicas don't race on first boot.
        await client.query(`SELECT pg_advisory_lock(2718281828)`);
        try {
            const reapplied = await client.query<{ name: string }>(
                `SELECT name FROM _migrations`
            );
            const seen = new Set(reapplied.rows.map((r) => r.name));
            for (const file of files) {
                if (seen.has(file)) continue;
                const sql = fs.readFileSync(
                    path.join(MIGRATIONS_DIR, file),
                    "utf8"
                );
                logger.info("Applying migration", { file });
                await client.query("BEGIN");
                try {
                    await client.query(sql);
                    await client.query(
                        `INSERT INTO _migrations (name) VALUES ($1)
                         ON CONFLICT (name) DO NOTHING`,
                        [file]
                    );
                    await client.query("COMMIT");
                    logger.info("Migration applied", { file });
                } catch (error: any) {
                    await client.query("ROLLBACK");
                    logger.error("Migration failed", {
                        file,
                        message: error?.message,
                    });
                    throw error;
                }
            }
        } finally {
            await client.query(`SELECT pg_advisory_unlock(2718281828)`);
        }
    } finally {
        client.release();
    }
}
