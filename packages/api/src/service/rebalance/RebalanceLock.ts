/**
 * Mutual exclusion between the rebalance round and the RiskMonitor so the
 * two can never submit withdrawals for the same vault concurrently.
 *
 * Dependency-free on purpose: both RebalanceOrchestrator and RiskMonitor
 * import this module, avoiding a circular import between them.
 */

export type LockHolder = "round" | "monitor";

let current: LockHolder | null = null;

export function tryAcquire(who: LockHolder): boolean {
    if (current !== null) return false;
    current = who;
    return true;
}

/**
 * Wait until the lock frees up, then take it. Returns false on timeout —
 * the caller decides whether to proceed anyway (the round does, loudly) or
 * skip (the monitor does).
 */
export async function acquireWithWait(
    who: LockHolder,
    timeoutMs: number,
    pollMs = 2000
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!tryAcquire(who)) {
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return true;
}

export function release(who: LockHolder): void {
    if (current === who) current = null;
}

export function heldBy(): LockHolder | null {
    return current;
}
