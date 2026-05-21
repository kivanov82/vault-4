import { Pool, PoolConfig } from "pg";
import { logger } from "../service/utils/logger";

let pool: Pool | null = null;

export function getPool(): Pool | null {
    if (pool) return pool;
    const url = process.env.DATABASE_URL;
    if (!url) {
        logger.warn("DATABASE_URL not set — trace persistence disabled");
        return null;
    }
    const config: PoolConfig = {
        connectionString: url,
        max: Number(process.env.DATABASE_POOL_MAX ?? 5),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
    };
    const socketHost = process.env.CLOUD_SQL_CONNECTION_NAME
        ? `/cloudsql/${process.env.CLOUD_SQL_CONNECTION_NAME}`
        : null;
    if (socketHost && !/host=/.test(url)) {
        config.host = socketHost;
    }
    pool = new Pool(config);
    pool.on("error", (err) => {
        logger.warn("Postgres pool error", { message: err?.message });
    });
    return pool;
}

export async function withDb<T>(
    op: string,
    fn: (client: import("pg").PoolClient) => Promise<T>,
    fallback?: T
): Promise<T | undefined> {
    const p = getPool();
    if (!p) return fallback;
    let client: import("pg").PoolClient | null = null;
    try {
        client = await p.connect();
        return await fn(client);
    } catch (error: any) {
        logger.warn("DB op failed", { op, message: error?.message });
        return fallback;
    } finally {
        client?.release();
    }
}
