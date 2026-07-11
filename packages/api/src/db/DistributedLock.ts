import { getPool } from "./pool";
import { logger } from "../service/utils/logger";

/**
 * Cross-instance mutual exclusion via a Postgres session advisory lock.
 *
 * The in-process RebalanceLock only excludes the round and the RiskMonitor
 * within ONE process. The 2026-07-09 zombie-revisions incident showed that is
 * not enough: leftover revision tags kept two OLD Cloud Run revisions warm,
 * each running its own scheduler, producing 2-3 concurrent rounds per cycle
 * with real duplicate trades. This lock extends the exclusion across
 * instances: whoever cannot take it skips its round/tick and logs an ALERT —
 * a second live instance is a deployment bug, never something to wait out.
 *
 * Session advisory locks free automatically when the holding connection
 * closes, so a crashed instance can never wedge the lock. The holding client
 * is checked out of the pool for the whole round (~30 min); pool max is 5,
 * which leaves plenty for trace writes.
 *
 * Fail-open by design: when the DB is unreachable the caller proceeds on the
 * in-process lock alone (trace-layer outages must never halt trading — same
 * convention as every other db/ module).
 */

const LOCK_CLASS = 0x76344c4b; // arbitrary app-unique int32 ("v4LK")
const LOCK_KEY = 1;

export type InstanceLockResult =
    | { status: "acquired"; release: () => Promise<void> }
    | { status: "held-elsewhere" }
    | { status: "db-unavailable" };

export async function tryAcquireInstanceLock(
    holder: string
): Promise<InstanceLockResult> {
    const pool = getPool();
    if (!pool) return { status: "db-unavailable" };
    let client: import("pg").PoolClient | null = null;
    try {
        client = await pool.connect();
        const r = await client.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock($1, $2) AS locked",
            [LOCK_CLASS, LOCK_KEY]
        );
        if (!r.rows[0]?.locked) {
            client.release();
            return { status: "held-elsewhere" };
        }
        const held = client;
        let released = false;
        return {
            status: "acquired",
            release: async () => {
                if (released) return;
                released = true;
                try {
                    await held.query("SELECT pg_advisory_unlock($1, $2)", [
                        LOCK_CLASS,
                        LOCK_KEY,
                    ]);
                    held.release();
                } catch (error: any) {
                    logger.warn(
                        "Instance lock release failed — destroying connection (PG frees the advisory lock with it)",
                        { holder, message: error?.message }
                    );
                    held.release(true);
                }
            },
        };
    } catch (error: any) {
        client?.release(true);
        logger.warn("Instance lock unavailable (DB error) — failing open", {
            holder,
            message: error?.message,
        });
        return { status: "db-unavailable" };
    }
}
