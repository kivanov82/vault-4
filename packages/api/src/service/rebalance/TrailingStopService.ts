import { withDb } from "../../db/pool";
import { logger } from "../utils/logger";
import {
    defaultExitConfig,
    shouldTrailingExit,
    trailingExitLevel,
} from "./ExitPolicy";

/**
 * Per-position trailing stop on peak ROE.
 *
 * Every ROE observation (round scan + RiskMonitor tick) ratchets the stored
 * high-water in `position_peak`. Once the peak reaches the arm threshold
 * (TRAILING_STOP_ARM_ROE_PCT, default +10%), giving back more than
 * TRAILING_STOP_GIVEBACK_RATIO (default 0.5) of the peak triggers a full
 * exit. The trigger level always sits in profit; the realized exit ROE
 * depends on how far the position fell between observations.
 *
 * Peaks are per-episode: rows are deleted on full exit. If a delete is missed
 * (DB hiccup) and the vault is re-entered, the staleness guard resets any row
 * untouched for PEAK_STALE_DAYS instead of ratcheting against the old episode.
 */

const PEAK_STALE_DAYS = 7;

export type TrailingCheck = {
    shouldExit: boolean;
    peakRoePct: number;
    exitLevelRoePct: number | null;
};

export class TrailingStopService {
    static enabled(): boolean {
        return (process.env.TRAILING_STOP_ENABLED ?? "true") !== "false";
    }

    /**
     * Record the current ROE (ratcheting the stored peak) and evaluate the
     * trailing stop. Returns null when disabled, ROE is unknown, or the DB is
     * unavailable — no trailing decisions without persisted peaks.
     */
    static async observeAndCheck(position: {
        vaultAddress: string;
        roePct?: number | null;
        amountUsd?: number | null;
    }): Promise<TrailingCheck | null> {
        if (!this.enabled()) return null;
        const roePct = position.roePct;
        if (roePct == null || !Number.isFinite(roePct)) return null;

        const peak = await withDb<number | null>(
            "trailingObserve",
            async (client) => {
                const r = await client.query<{ peak_roe_pct: string }>(
                    `INSERT INTO position_peak (vault_address, peak_roe_pct, peak_equity_usd)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (vault_address) DO UPDATE SET
                         peak_roe_pct = CASE
                             WHEN position_peak.updated_at < now() - make_interval(days => $4)
                                 THEN EXCLUDED.peak_roe_pct
                             ELSE GREATEST(position_peak.peak_roe_pct, EXCLUDED.peak_roe_pct)
                         END,
                         peak_equity_usd = CASE
                             WHEN position_peak.updated_at < now() - make_interval(days => $4)
                                 OR EXCLUDED.peak_roe_pct > position_peak.peak_roe_pct
                                 THEN EXCLUDED.peak_equity_usd
                             ELSE position_peak.peak_equity_usd
                         END,
                         updated_at = now()
                     RETURNING peak_roe_pct`,
                    [
                        position.vaultAddress.toLowerCase(),
                        roePct,
                        position.amountUsd ?? null,
                        PEAK_STALE_DAYS,
                    ]
                );
                const value = r.rows[0]?.peak_roe_pct;
                return value != null ? Number(value) : null;
            },
            null
        );
        if (peak == null || !Number.isFinite(peak)) return null;

        const config = defaultExitConfig();
        return {
            shouldExit: shouldTrailingExit(roePct, peak, config),
            peakRoePct: peak,
            exitLevelRoePct: trailingExitLevel(peak, config),
        };
    }

    /** Drop the peak row after a full exit — the episode is over. */
    static async clearPeak(vaultAddress: string): Promise<void> {
        await withDb("trailingClearPeak", async (client) => {
            await client.query(
                `DELETE FROM position_peak WHERE vault_address = $1`,
                [vaultAddress.toLowerCase()]
            );
        });
    }

    /**
     * Self-healing sweep: remove peak rows for vaults we no longer hold
     * (covers exits whose clearPeak was lost to a DB hiccup).
     */
    static async sweepClosedPeaks(openVaultAddresses: string[]): Promise<void> {
        const open = openVaultAddresses.map((a) => a.toLowerCase());
        await withDb("trailingSweepPeaks", async (client) => {
            const r = await client.query(
                `DELETE FROM position_peak
                 WHERE NOT (vault_address = ANY($1::text[]))`,
                [open]
            );
            if (r.rowCount) {
                logger.info("Swept stale position peaks", { removed: r.rowCount });
            }
        });
    }
}
