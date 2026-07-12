---
name: vault-performance-forensics
description: "Professional fund-manager forensic of the vault-4 trading strategy's live performance. Use whenever the user asks to review strategy performance or PnL, asks why returns are flat/sideways/negative, wants the epoch scoreboard or go/no-go checked, asks 'how are we doing', wants a churn/turnover or drawdown analysis, or wants to know whether a bad stretch was strategy or infrastructure. Also use after incidents (zombie revisions, credit exhaustion, missed stops) to quantify their P&L impact. Triggers on /forensic, performance review, strategy review, epoch check, PnL analysis."
---

# Vault-4 Performance Forensics

Reproducible methodology behind `STRATEGY-FORENSICS-2026-06.md` and
`STRATEGY-FORENSICS-2026-07.md` (repo root). The goal is a skeptical,
evidence-first answer to "is the strategy making money, and if not, exactly
where does the P&L leak?" — attributing every dollar to selection, exits,
churn, or infrastructure before proposing any change.

Read the two prior reports first. They are the baseline you compare against,
and their disproven hypotheses (§ "Things explicitly NOT worth doing") must
not be re-proposed without new evidence.

## Ground rules (the skepticism that makes it a forensic)

1. **Attribute before you judge.** A bad number is not a strategy verdict
   until you've ruled out contamination: duplicate schedulers, degraded
   (claude-fallback / risk-only) rounds, missed fills, stale data. Every
   prior forensic found infrastructure hiding inside "strategy" losses.
2. **Realized ≠ mark-to-market.** The epoch endpoint counts closed trades
   only. Always ALSO compute MTM (TVL change net of flows) — the two can
   disagree in sign, and both belong in the report.
3. **Originated ≠ inherited.** Judge the current strategy only on
   `closesOriginated` (positions it opened AND closed). Closes of inherited
   inventory are cleanup, not signal.
4. **All-time metrics include the pre-strategy manual-trading era** (−98.7%
   DD) and the HL account's all-time PnL includes it too. Never attribute
   those to the automated strategy.
5. **Expectancy arithmetic beats narrative.** Breakeven win rate =
   avgLoss / (avgWin + avgLoss). Compare to the actual win rate — if they're
   within a point or two, the curve is sideways because there is no drift,
   and no story about "market conditions" changes that.
6. **Backtest-disproven ideas stay dead**: tightening soft/hard stops loses
   money (whipsaw — 2026-06 backtest §6); hysteresis and trailing re-tuning
   were inert. The levers with evidence behind them are LESS turnover and
   better execution, not tighter thresholds.

## Step 1 — Collect the data (all endpoints, `?refresh=true` to bypass cache)

Base URL: `https://vault-4-s6qnbk6izq-ew.a.run.app`

| Endpoint | What it gives |
| --- | --- |
| `/api/metrics` | All-time: TVL (vault-only `tvlUsd` vs smooth `totalCapitalUsd` + `pendingDeployUsd`), 30d/60d/inception PnL %, win rate, max DD |
| `/api/metrics/epoch` | Fresh-epoch KPIs since `METRICS_EPOCH_START`: `closes` / **`closesOriginated`** / `closesInherited` (win rate, avg win/loss, winLossRatio, PF, expectancy, churn), **`mtm`** (flow-neutral PnL $/% + max DD since epoch), deposits, round counts, event counts |
| `/api/history?page=1&pageSize=100` | HL ledger, FIFO realized PnL per close — the per-trade tape |
| `/api/trace/rounds` | Round list with `summary_json` (chopBrake, rotationHurdle, withdrawalsByReason, mode/reason) |
| `/api/trace/rounds/:id` | Per-round position events (amounts, reasons) |
| `/api/positions` | Current book: per-position USD, ROE, PnL |
| `/api/portfolio/chart` | Equity/PnL series (shape of the curve) |

Also useful: `gcloud logging read` filtered on
`resource.labels.service_name="vault-4"` for `ALERT_`, `severity>=ERROR`,
`"Risk monitor"`, and revision names (auth-check gcloud first — see the
`gcloud-auth-refresh` skill).

## Step 2 — Scoreboard + expectancy arithmetic

Build the headline table: all-time vs epoch (`closesOriginated` as the
primary column). For each: return, win rate, avg win / avg loss, win/loss
ratio, profit factor, expectancy per close, churn count/loss, max DD.

Then do the arithmetic explicitly in the report:

- breakeven win rate = avgLoss / (avgWin + avgLoss); compare to actual
- annualize the inception return; compare to risk-free and to max DD (Calmar)
- MTM cross-check: use the epoch endpoint's `mtm` block (flow-neutral:
  Δrealized + Δ(vault_equity − open_basis) from portfolio_series) and state
  it next to realized — the closed-trade stats realize losses eagerly while
  winners sit unrealized, so the two can disagree in sign. `tvlUsd` excludes
  cash in the perps wallet — after a big exit, proceeds sit in the wallet
  until the next round's deposits, so a raw-TVL drop right after an exit is
  mostly cash-in-transit; use `totalCapitalUsd` for capital comparisons.

## Step 3 — Contamination & ops check (do this BEFORE judging the strategy)

Scan `/api/trace/rounds` for the incident signatures:

- **Duplicate schedulers / zombie revisions**: multiple rounds with
  `started_at` within seconds of each other. Old-code rounds are identifiable
  by summary SHAPE (e.g. pre-overhaul summaries lack `chopBrake` /
  `rotationHurdle` keys). Confirm via logs: group `"Rebalance round starting"`
  by `resource.labels.revision_name`.
- **Degraded operation**: `status=aborted` with `reason:"claude-fallback"`,
  or completed with `mode:"risk-only"`. Cause is usually Anthropic billing
  ("credit balance too low") or the node/undici pin — check
  `ALERT_DEGRADED_ROUND` in logs. `/health` does NOT prove Claude works.
- **Stuck rounds**: `status=running` with old `started_at` (startup cleanup
  auto-aborts them as `stale-running-cleanup`; if you see one live, the
  instance died mid-round).
- **Missed/zero fills**: `exit_retry` events, `unsettledWithdrawals > 0` in
  summaries (the Otter Quant −$213 class of loss).
- **Cross-instance lock**: any `ALERT_INSTANCE_LOCK` log line means a second
  live session existed — treat the whole window as contaminated.

Quantify the damage: list every close executed by a contaminated round and
sum it separately. If contamination overlaps the epoch window, say plainly
whether the epoch scoreboard is measuring the strategy at all (2026-07: it
wasn't — epoch was re-based to 2026-07-09 for exactly this reason).

## Step 4 — Per-close tape decomposition

From `/api/history`, list every `vaultWithdraw` in the window with time,
vault, amount, realized PnL. Then decompose:

- **Tails**: top losses — what rule (or failure) produced each? Match to
  round events (`exit_hard_sl`, `exit_soft_sl`, `exit_not_recommended`,
  `exit_trailing_stop`, `exit_risk_monitor`, `exit_inactive`).
- **Churn band**: losses of 0–5% of consumed basis. Reconstruct round trips
  by pairing each exit with its entry deposit (same vault, prior
  `vaultDeposit`): hold days, in-amount, out-amount, net. Call out round
  trips held < ~10 days for ~$0 — that's ranking noise paying spread.
- **Win concentration**: what share of gross wins is the single best close?
- **Re-entries**: vaults exited then re-entered inside the window (the
  cooldown covers loss-exits only — profit-exit re-entries are legal but
  still churn; flag them).

## Step 5 — Turnover & policy behavior

- Turnover: epoch `deposits.totalUsd` vs TVL, and avg position lifetime
  (positions ÷ closes-per-day). Healthy target after the 2026-07 changes:
  ≤ ~25% of book per 10 days (it was >100%).
- Event counts (`/api/metrics/epoch`): `hold_period`, `hold_not_recommended`,
  `hold_chop`, `hold_rotation_hurdle` vs `exit_not_recommended` — are the
  anti-churn gates actually absorbing rotations, or just delaying them?
- Round summaries: `rotationHurdle.rotationsHeld`, `chopBrake.active` /
  `rotationsDeferred`, `trimsSkippedByGate` — verify each mechanism fires in
  live rounds, not just in code.
- The geometry check: avg hold days × per-day vault drift (a good vault does
  20–40%/yr ≈ $0.12–0.25/day on a ~$225 slot) = the CEILING on avg win size.
  Compare that ceiling to what the stops permit (−15%/−25% ≈ −$34/−$56).
  If the ratio is far below 1, turnover — not selection — is the binding
  constraint.

## Step 6 — Write the report

Save as `STRATEGY-FORENSICS-YYYY-MM.md` at repo root; add a dated status
stamp at the top of the superseded report pointing to the new one. Structure
(matches the prior two):

```
# Vault-4 Strategy Forensics — YYYY-MM-DD
## 0. Headline verdict        (one paragraph, the answer)
## 1. Scoreboard              (all-time vs epoch table, MTM cross-check)
## 2..N Findings              (numbered, evidence-first, $ amounts named,
                               contamination/ops findings BEFORE strategy findings)
## What's genuinely working   (be fair — list what behaved as designed)
## Recommendations, ranked    (each mapped to a finding; ops before alpha;
                               nothing the backtest already disproved)
```

Every claim carries a number and its source (endpoint / round id / ledger
row). Update project memory afterward (forensics memory + MEMORY.md index),
and if the epoch basis or KPI semantics changed, sync `packages/api/CLAUDE.md`
and the root `CLAUDE.md`.

## Known traps (each one cost real time or money once)

- HL ledger propagation lags ~3 min behind round-end; same-day PnL on a
  just-entered position can be a basis artifact — don't headline it.
- `pnlChange30dPct` on `/api/metrics` is realized-only.
- HL `accountEquity` = perps wallet + vault equities; never add invested USD
  on top.
- The epoch endpoint replays the FULL ledger for basis but filters closes to
  the window — pre-epoch basis is correct, don't "fix" it.
- Round summaries are the only place old-code vs new-code rounds can be told
  apart after the fact — never delete summary keys casually.
- Go/no-go review (~2026-09-15→10-01) is judged ONLY on
  `/api/metrics/epoch` → `closesOriginated`, epoch basis 2026-07-09.
- The web UI (vault-4.xyz) presents the entire track record from the epoch
  (uptime, chart re-based to $0, history clipped) — lifetime numbers exist
  ONLY in the API. A forensic must still pull the lifetime view; don't
  mistake the UI's epoch framing for the full history.
