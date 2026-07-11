/*
 * Decision-logic backtest harness.
 *
 * Replays the exit-policy rules (hard SL, soft SL, trailing stop,
 * non-recommended hysteresis) against the recorded trace history with
 * alternative thresholds, and diffs the simulated exits against what the
 * live system actually did. Uses the SAME pure functions from
 * src/service/rebalance/ExitPolicy.ts that the orchestrator and RiskMonitor
 * run, so a replay is a faithful re-execution of the decision logic.
 *
 * Data source: the /api/trace endpoints of a running API (defaults to the
 * local dev server; point --base-url at the Cloud Run service to replay
 * production history). No DB credentials needed.
 *
 * Usage:
 *   npx ts-node scripts/backtest.ts \
 *     --base-url https://vault-4-s6qnbk6izq-ew.a.run.app \
 *     --hard-sl -20 --soft-sl -12 --trailing-arm 8 --trailing-giveback 0.4 \
 *     --nr-rounds 2
 *
 * Honest limitations (decision-logic replay, not a market simulator):
 *   - Positions are only observed at recorded decision points (every round,
 *     plus RiskMonitor ticks going forward). PnL between observations is
 *     invisible — simulated exits use the equity at the observation where
 *     the alternative rule would have fired.
 *   - When the alternative policy holds LONGER than the actual exit, there
 *     is no observed data past the actual exit; those episodes are reported
 *     as "held-longer" with PnL pinned to the actual outcome.
 */

import {
    shouldHardStop,
    shouldSoftStop,
    shouldTrailingExit,
    defaultExitConfig,
    type ExitConfig,
} from "../src/service/rebalance/ExitPolicy";

type TraceEvent = {
    id: string;
    round_id: string | null;
    vault_address: string;
    vault_snapshot_id: string | null;
    occurred_at: string;
    action: string;
    amount_usd: string | null;
    pre_equity_usd: string | null;
    our_basis_usd_before: string | null;
    our_realized_pnl_usd: string | null;
    our_unrealized_pnl_usd: string | null;
    our_roe_pct_at_decision: string | null;
    reason_text: string | null;
};

type Snapshot = {
    id: string;
    vault_address: string;
    is_aligned: boolean | null;
    vault_name: string | null;
};

type Observation = {
    time: number;
    roundId: number | null;
    action: string;
    roePct: number | null;
    equityUsd: number | null;
    basisUsd: number | null;
    unrealizedUsd: number | null;
    realizedUsd: number;
    isRecommended: boolean | null;
    isAligned: boolean | null;
};

type Episode = {
    vault: string;
    name: string;
    observations: Observation[];
    actualExit: Observation | null;
    actualRealizedUsd: number;
};

const RECOMMENDED_ACTIONS = new Set([
    "deposit",
    "topup",
    "trim",
    "skip_recommended",
    "hold_soft_sl",
]);
const NOT_RECOMMENDED_ACTIONS = new Set([
    "hold_period",
    "hold_not_recommended",
    "exit_not_recommended",
]);
const EXIT_ACTIONS = new Set([
    "exit_hard_sl",
    "exit_soft_sl",
    "exit_inactive",
    "exit_not_recommended",
    "exit_risk_monitor",
    "exit_trailing_stop",
    "exit_retry",
]);

function arg(name: string): string | undefined {
    const idx = process.argv.indexOf(`--${name}`);
    return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function numArg(name: string, fallback: number): number {
    const raw = arg(name);
    if (raw == null) return fallback;
    const num = Number(raw);
    if (!Number.isFinite(num)) {
        console.error(`Invalid --${name}: ${raw}`);
        process.exit(1);
    }
    return num;
}

async function fetchJson(url: string): Promise<any> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
}

async function loadEpisodes(baseUrl: string, maxRounds: number): Promise<Episode[]> {
    const { rounds } = await fetchJson(`${baseUrl}/api/trace/rounds?limit=${maxRounds}`);
    const byVault = new Map<string, Observation[]>();
    const names = new Map<string, string>();

    const ordered = [...rounds].sort((a: any, b: any) => Number(a.id) - Number(b.id));
    for (const round of ordered) {
        const detail = await fetchJson(`${baseUrl}/api/trace/rounds/${round.id}`);
        const alignedBySnapshot = new Map<string, boolean | null>(
            (detail.vaultSnapshots as Snapshot[]).map((s) => [s.id, s.is_aligned])
        );
        for (const s of detail.vaultSnapshots as Snapshot[]) {
            if (s.vault_name) names.set(s.vault_address.toLowerCase(), s.vault_name);
        }
        for (const ev of detail.positionEvents as TraceEvent[]) {
            const vault = ev.vault_address.toLowerCase();
            const obs: Observation = {
                time: new Date(ev.occurred_at).getTime(),
                roundId: ev.round_id != null ? Number(ev.round_id) : null,
                action: ev.action,
                roePct:
                    ev.our_roe_pct_at_decision != null
                        ? Number(ev.our_roe_pct_at_decision)
                        : null,
                equityUsd: ev.pre_equity_usd != null ? Number(ev.pre_equity_usd) : null,
                basisUsd:
                    ev.our_basis_usd_before != null
                        ? Number(ev.our_basis_usd_before)
                        : null,
                unrealizedUsd:
                    ev.our_unrealized_pnl_usd != null
                        ? Number(ev.our_unrealized_pnl_usd)
                        : null,
                realizedUsd:
                    ev.our_realized_pnl_usd != null ? Number(ev.our_realized_pnl_usd) : 0,
                isRecommended: RECOMMENDED_ACTIONS.has(ev.action)
                    ? true
                    : NOT_RECOMMENDED_ACTIONS.has(ev.action)
                      ? false
                      : null,
                isAligned:
                    ev.vault_snapshot_id != null
                        ? (alignedBySnapshot.get(ev.vault_snapshot_id) ?? null)
                        : null,
            };
            if (!byVault.has(vault)) byVault.set(vault, []);
            byVault.get(vault)!.push(obs);
        }
    }

    // Split each vault's observation stream into episodes at full exits.
    const episodes: Episode[] = [];
    for (const [vault, observations] of byVault) {
        observations.sort((a, b) => a.time - b.time);
        let current: Observation[] = [];
        for (const obs of observations) {
            current.push(obs);
            if (EXIT_ACTIONS.has(obs.action)) {
                episodes.push(
                    makeEpisode(vault, names.get(vault) ?? vault.slice(0, 10), current)
                );
                current = [];
            }
        }
        if (current.length) {
            episodes.push(
                makeEpisode(vault, names.get(vault) ?? vault.slice(0, 10), current)
            );
        }
    }
    return episodes.filter((e) => e.observations.some((o) => o.roePct != null));
}

function makeEpisode(vault: string, name: string, observations: Observation[]): Episode {
    const exits = observations.filter((o) => EXIT_ACTIONS.has(o.action));
    const realized = observations.reduce((sum, o) => sum + o.realizedUsd, 0);
    return {
        vault,
        name,
        observations,
        actualExit: exits.length ? exits[exits.length - 1] : null,
        actualRealizedUsd: realized,
    };
}

type SimResult = {
    episode: Episode;
    simExit: Observation | null;
    simReason: string | null;
    simPnlUsd: number | null;
    diff: "same" | "earlier-exit" | "held-longer" | "open";
};

function simulate(episode: Episode, config: ExitConfig): SimResult {
    let peak: number | null = null;
    let nrStreak = 0;

    for (const obs of episode.observations) {
        const roe = obs.roePct;
        if (roe == null) continue;
        // Mirror the live scan's dust filter (MIN_POSITION_USD): residue rows
        // with sub-$1 equity or basis produce ROE ≈ -100% artifacts that the
        // orchestrator never evaluates.
        if (obs.equityUsd != null && obs.equityUsd < 1) continue;
        if (obs.basisUsd != null && obs.basisUsd < 1) continue;
        peak = peak == null ? roe : Math.max(peak, roe);
        const unreal =
            obs.unrealizedUsd ??
            (obs.equityUsd != null && obs.basisUsd != null
                ? obs.equityUsd - obs.basisUsd
                : null);

        if (shouldHardStop(roe, config)) {
            return finish(episode, obs, "hard-stop-loss", unreal);
        }
        if (
            obs.isRecommended != null &&
            shouldSoftStop(roe, obs.isRecommended, obs.isAligned ?? true, config)
        ) {
            return finish(episode, obs, "soft-stop-loss", unreal);
        }
        if (shouldTrailingExit(roe, peak, config)) {
            return finish(episode, obs, "trailing-stop", unreal);
        }
        if (obs.isRecommended === false && obs.action !== "hold_period") {
            nrStreak += 1;
            const exitAfter = Math.max(1, config.notRecommendedRounds);
            // Mirrors the live rule: losers exit on the first non-recommended
            // round past the hold period, winners get the hysteresis streak.
            if (roe < 0 || nrStreak >= exitAfter) {
                return finish(episode, obs, "not-recommended", unreal);
            }
        } else if (obs.isRecommended === true) {
            nrStreak = 0;
        }
    }

    // The alternative policy never exited within the observed window.
    if (episode.actualExit) {
        return {
            episode,
            simExit: null,
            simReason: null,
            simPnlUsd: episode.actualRealizedUsd,
            diff: "held-longer",
        };
    }
    return { episode, simExit: null, simReason: null, simPnlUsd: null, diff: "open" };
}

function finish(
    episode: Episode,
    obs: Observation,
    reason: string,
    unrealizedUsd: number | null
): SimResult {
    const actual = episode.actualExit;
    const same = actual != null && actual.time === obs.time;
    return {
        episode,
        simExit: obs,
        simReason: reason,
        // Same decision as live ⇒ same outcome (the realized fill is truth);
        // an earlier exit uses the unrealized PnL at that observation.
        simPnlUsd: same || actual == null ? episode.actualRealizedUsd : unrealizedUsd,
        diff: same || actual == null ? "same" : "earlier-exit",
    };
}

async function main() {
    const baseUrl =
        arg("base-url") ?? process.env.VAULT_API_BASE_URL ?? "http://localhost:3000";
    const maxRounds = numArg("rounds", 100);
    const defaults = defaultExitConfig();
    const config: ExitConfig = {
        stopLossPct: numArg("soft-sl", defaults.stopLossPct),
        hardStopLossPct: numArg("hard-sl", defaults.hardStopLossPct),
        minHoldDays: numArg("min-hold", defaults.minHoldDays),
        notRecommendedRounds: numArg("nr-rounds", defaults.notRecommendedRounds),
        trailingArmRoePct: numArg("trailing-arm", defaults.trailingArmRoePct),
        trailingGivebackRatio: numArg("trailing-giveback", defaults.trailingGivebackRatio),
        // Trim gating happens in the trim pass, which the exit-policy replay
        // does not simulate — carried through only to satisfy ExitConfig.
        trimMinRoePct: numArg("trim-min-roe", defaults.trimMinRoePct),
        trimOverweightTolerancePct: numArg(
            "trim-tolerance",
            defaults.trimOverweightTolerancePct
        ),
        // The rotation hurdle and chop-deferral floor act in the round's
        // rotation pass, which this exit-policy replay does not simulate —
        // carried through only to satisfy ExitConfig.
        rotationScoreMargin: numArg(
            "rotation-margin",
            defaults.rotationScoreMargin
        ),
        chopDeferMinRoePct: numArg(
            "chop-defer-min-roe",
            defaults.chopDeferMinRoePct
        ),
    };

    console.log(`Backtest against ${baseUrl} (up to ${maxRounds} rounds)`);
    console.log(`Config: ${JSON.stringify(config)}\n`);

    const episodes = await loadEpisodes(baseUrl, maxRounds);
    const closed = episodes.filter((e) => e.actualExit != null);
    console.log(
        `Loaded ${episodes.length} episodes (${closed.length} closed) from trace history\n`
    );

    const results = episodes.map((e) => simulate(e, config));

    let actualTotal = 0;
    let simTotal = 0;
    const rows: string[] = [];
    const openSignals: string[] = [];
    for (const r of results) {
        // Open episodes have no actual outcome to compare against — keep the
        // totals strictly over closed episodes, but surface any open position
        // the alternative policy would exit right now (a live signal).
        if (!r.episode.actualExit) {
            if (r.simExit) {
                openSignals.push(
                    `  ${r.episode.name.slice(0, 36).padEnd(36)} sim=${r.simReason} ` +
                        `@${new Date(r.simExit.time).toISOString().slice(0, 10)} ` +
                        `roe=${r.simExit.roePct?.toFixed(2)}%`
                );
            }
            continue;
        }
        const actualPnl = r.episode.actualRealizedUsd;
        const simPnl = r.simPnlUsd ?? actualPnl;
        actualTotal += actualPnl;
        simTotal += simPnl;
        if (r.diff !== "same") {
            const when = r.simExit
                ? new Date(r.simExit.time).toISOString().slice(0, 10)
                : "-";
            rows.push(
                `  ${r.episode.name.slice(0, 36).padEnd(36)} ${r.diff.padEnd(12)} ` +
                    `sim=${(r.simReason ?? "hold").padEnd(16)} @${when} ` +
                    `actual=$${actualPnl.toFixed(2)} sim=$${simPnl.toFixed(2)} ` +
                    `Δ=$${(simPnl - actualPnl).toFixed(2)}`
            );
        }
    }

    console.log(`Episodes where the alternative policy diverges:`);
    console.log(rows.length ? rows.join("\n") : "  (none — policy matches actual behavior)");
    if (openSignals.length) {
        console.log(`\nOpen positions the alternative policy would exit at their latest observation:`);
        console.log(openSignals.join("\n"));
    }
    console.log(`\nTotals over closed episodes:`);
    console.log(`  actual realized: $${actualTotal.toFixed(2)}`);
    console.log(
        `  simulated:       $${simTotal.toFixed(2)}  (Δ $${(simTotal - actualTotal).toFixed(2)})`
    );
    console.log(
        `\nNote: "held-longer" episodes are pinned to actual PnL (no observed data past the actual exit),` +
            `\nso simulated totals are conservative for looser policies.`
    );
}

main().catch((error) => {
    console.error("backtest failed:", error);
    process.exit(1);
});
