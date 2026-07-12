# Vault-4 Strategy Forensics — 2026-07-11

Follow-up to `STRATEGY-FORENSICS-2026-06.md`, nine days into the fresh epoch
that started with the 2026-07-02 strategy overhaul (rev `vault-4-00112-mdm`,
commit `8895a88`). Data sources:

- **`GET /api/metrics`** — all-time platform metrics (2026-07-11 snapshot).
- **`GET /api/metrics/epoch`** — fresh-epoch KPIs since 2026-07-02.
- **`GET /api/trace/rounds` + round details** — per-round summaries and
  position events (rounds 24–39).
- **`GET /api/history`** — HL ledger with FIFO realized PnL per close.
- Source review of `RebalanceOrchestrator.ts`, `ExitPolicy.ts`.

---

## 0. Headline verdict

The equity curve is sideways because the strategy's per-trade expectancy is
arithmetically ~zero, and what little gross edge exists is consumed by two
taxes — rotation churn and a monthly operational incident. On top of that,
**the fresh-epoch scoreboard is currently measuring the wrong strategy**: from
July 2–8 the book was mostly traded by zombie pre-overhaul revisions (see the
2026-07-09 incident), and the overhauled strategy has **zero closed trades of
its own origination**. The September go/no-go, as instrumented at the time of
this report, would judge the old code.

---

## 1. Scoreboard (2026-07-11)

| | All-time (185d) | Fresh epoch (9.8d, 16 closes) |
| --- | --- | --- |
| Return | +1.85% (~3.7% annualized) | realized **−$35.40** / MTM **≈ +2.3%** (TVL $2,428 → $2,483) |
| Win rate | 56.0% | 46.7% (7W / 8L / 1 flat) |
| Avg win / avg loss | +$8.38 / −$11.07 (June ledger) | **+$3.25 / −$7.27** |
| Win/loss ratio | 0.76 | **0.45** (bar: ≥ 1) |
| Profit factor | 1.17 (June) | **0.39** |
| Expectancy / close | +$0.75 (June) | **−$2.21** (bar: > 0) |
| Max drawdown | −18.9% | — |
| Churn closes | 51 of 85 losses in 0→−5% band (June) | 5 closes, −$12.66 |

Epoch turnover: 15 deposits totaling **$2,605** against a **$2,483** book —
**>100% of the book turned over in 10 days** (~3,900% annualized). Average
position lifetime ≈ 7 days (16 closes / 9.8d across ~11 positions).

---

## 2. Finding 1 — the epoch is contaminated (zombie revisions traded the book)

Cross-referencing round summaries against the ledger:

- **July 2**: rounds 24/25/26 started within **one second** of each other
  (13:47:46.488 / .495 / 47.455) — three schedulers, three revisions. **July
  4**: same pattern with rounds 27/28/29. Rounds 24 and 29 carry the new-code
  summary shape (`chopBrake`, `trimsSkippedByGate`); **rounds 25/26/27/28 do
  not** — they were the zombie revisions (tags `fix`, `x402` + minScale=1)
  running **pre-overhaul code**.
- The new-code rounds did **nothing** on both days — round 24's chop brake
  correctly deferred its rotations (`rotationsDeferred: 2`, `depositFactor:
  0.5`), round 29 submitted zero trades. **Every trade on July 2 and 4 was
  executed by the old code**: 9 closes, ~$1,900 turned over, including:
  - **Overdose −$29.03** — the single biggest epoch loss;
  - an **ungated trim** of a barely-profitable position (QMNS partial, +$0.20)
    — exactly what profit-gated trims were built to prevent;
  - the sale of **Realist Capital at +$17.83** — 78% of the epoch's entire
    gross wins — which the new code then **re-bought on July 9** (−3.2% at
    report time). The loss-only re-entry cooldown does not cover profit exits.
- **July 6–8**: Anthropic credits drained (~3× spend from the duplicate
  schedulers) → 5 aborted `claude-fallback` rounds + 2 risk-only rounds. The
  new strategy still wasn't trading. The degradation ran **3 days** before
  detection — there is no alerting on fallback/aborted rounds.
- First clean new-code rounds with Claude: **38 (Jul 9)** and **39 (Jul 11)**.
  Even their five exits (−$27.17 total, zero wins) were cleanup of inventory
  opened by zombies or pre-epoch (FKA −$16.42, CTC −$3.04, +convexity −$3.11
  inherited; BULBUL2DAO −$4.47 and Archangel −$0.13 were **opened by zombie
  rounds** 27 and 26).

**Attribution of the epoch's −$35.40 realized:** ≈ −$9.8 executed directly by
zombie rounds; ≈ −$27.2 inherited-inventory cleanup by rounds 38/39; +$1.6
trailing stop during the fallback window. **Closed trades originated by the
overhauled strategy: zero.**

Also of note: round 34 (2026-07-07) is stuck in `running` with
`completed_at = null`.

---

## 3. Finding 2 — why it goes sideways: the expectancy arithmetic

"Sideways with no certain trend" is what a zero-expectancy distribution looks
like when plotted:

- With all-time win/loss sizes (+$8.38 / −$11.07), the **breakeven win rate is
  56.9%**. The actual all-time win rate is **56.0%**. The system operates
  within one percentage point of breakeven, permanently. The curve isn't
  failing to trend — there is no drift to express.
- Epoch geometry (+$3.25 / −$7.27) puts breakeven at **69%**; actual is 47%.
- Winner concentration is extreme: one close (Realist +$17.83) is 78% of epoch
  gross wins; the other 6 wins average **$0.83**.

---

## 4. Finding 3 — the root cause is geometric: hold period caps wins, stops set losses

No threshold tuning reaches this (the June backtest already proved tuning the
stops makes things worse):

- Average position lifetime ≈ **7 days**; a good underlying vault earns maybe
  20–40%/yr ⇒ **$0.12–0.25/day on a $225 position**. A 5–9 day hold caps the
  expected win at **$1–2** — exactly the observed epoch avg win ex-outlier
  ($0.83).
- Meanwhile the risk system tolerates −15%/−25% ROE = **−$34 to −$56 per
  position**, and delivers mid-tail losses regularly (−$16.42 and −$29.03 this
  epoch; −$78 and −$213 historically).

Win size is capped by rotation cadence; loss size is set by the stops. That
manufactures the 0.45 win/loss ratio structurally. The levers that change it:
**hold longer / rotate less** (survives the backtest evidence) or tighter
effective risk (disproven — converts recoverable dips into locked losses).

---

## 5. Finding 4 — churn still has no price tag

June forensics action §7.5 — *"rotation should require the replacement's edge
to clearly exceed the incumbent's plus round-trip cost"* — is the **one §7
action that never actually shipped**. Rotation is gated by `MIN_HOLD_DAYS=5`,
2-round hysteresis, and the loss-only re-entry cooldown, but there is **no
score-margin hurdle**: any reshuffle of Claude's ranking that survives
hysteresis executes. The epoch tape:

```
Archangel      in Jul-02 $268.35 → out Jul-11 $268.27   9-day round trip for −$0.13
BULBUL2DAO     in Jul-04 $215.62 → out Jul-11 $211.17   7-day round trip for −$4.47
Symphony→一三七 rotated Jul-04, trailing-stopped Jul-06   2 round trips in 2 days, +$1.60
Realist        sold +$17.83 Jul-02, re-bought Jul-09     now −3.2%
```

Six of eight epoch losses sit in the 0→−5% "paid to reshuffle" band (−$12.7 —
matching the epoch churn KPI). At single-dollar expectancy this is a
first-order tax, not noise.

---

## 6. Finding 5 — the ops tax is still the largest single P&L driver

Every month has had an infrastructure incident whose cost is a multiple of the
monthly edge:

| When | Incident | Cost |
| --- | --- | --- |
| Jun 2 | Otter Quant $0-fill withdrawal bug | **−$213** |
| Jun 17 | 429 burst → missed −18% stop (round 14) | risk exposure |
| Jun 22–26 | unpinned node:22 → Claude calls dead, rounds 18/19 aborted | ~5 days down |
| Jul 2–9 | zombie revisions trading the book + 3× Claude spend → credit exhaustion → 3 days heuristic fallback | epoch contaminated |

Cumulative ops damage exceeds the entire all-time realized edge (+$164 as of
June). **A strategy earning ~$1/day cannot show a trend while its execution
layer injects a −$30 to −$213 shock monthly.** Root causes still open at the
time of this report: `RebalanceLock` is in-process only (no cross-instance
lock), no alerting on fallback/aborted rounds, no Anthropic billing alert,
round 34 stuck `running`.

---

## 7. Finding 6 — the chop brake has its own negative-skew bias

`RebalanceOrchestrator.ts` defers chop-round rotations only when
`roePct >= 0`. Underwater non-recommended positions are still rotated out
during chop — realizing dips in precisely the regime the June backtest showed
mean-reverts. Round 38 demonstrated it: 6 profitable rotations deferred, 3
underwater ones executed (−$22.6 realized on a chop day). The overhaul fixed
"trim winners in chop" but kept "sell losers at the bottom of chop."

---

## 8. What's genuinely working

- The selector's alpha signal is real but small: 56% hit rate, $44–95 winners
  when held, book +3.6% unrealized at report time (Scared Money +12%).
- Risk-only rounds and the chop brake behaved exactly as designed on Jul 2/4 —
  the new code correctly did nothing in chop; the zombies did the damage.
- The trailing stop fired correctly during the outage window (一三七 +$1.60).
- Stop calibration remains backtest-validated; leave the thresholds alone.

The problem was never picking — the edge is spent on turnover and incidents
before it can compound.

---

## 9. Recommendations, ranked

1. **Re-base the epoch to 2026-07-09** and/or filter epoch closes to positions
   *originated* after the clean date. Without this the ~09/15 go/no-go is
   theater. Also read the go/no-go on **both** closed-trade KPIs and MTM.
2. **Ops before alpha**: cross-instance rebalance lock (DB advisory lock),
   alerting on aborted/fallback rounds and Anthropic balance, auto-abort stale
   `running` rounds (fixes round 34 and prevents recurrence).
3. **Ship the rotation hurdle** (the un-shipped June §7.5): exiting a
   *profitable* incumbent must clear a real margin — replacement edge vs
   incumbent plus round-trip cost. Target turnover ≤ ~25%/10d instead of
   ~100%.
4. **Widen the chop-brake deferral to mildly negative ROE** (e.g. > −8%),
   leaving real stops untouched.
5. At the go/no-go, answer the structural question honestly: at $2.5k TVL and
   ~$1/day gross edge, is this an absolute-return product or a strategy R&D
   platform? If the former, hold-period/turnover redesign is mandatory.

### Implementation status (updated 2026-07-12)

All shipped and live:

- **2026-07-11, rev `vault-4-00114-b4j`** (`:rotation-hurdle`, commit
  `ee334a2`) — items 1–4: epoch re-base to 2026-07-09 + `closesOriginated`/
  `closesInherited` split, rotation hurdle (`ROTATION_SCORE_MARGIN=8`,
  migration 006), chop-brake floor (`CHOP_DEFER_MIN_ROE_PCT=-8`),
  cross-instance advisory lock, stale-round auto-abort (cleared stuck round
  34), `ALERT_DEGRADED_ROUND`/`ALERT_INSTANCE_LOCK` log markers.
- **2026-07-12, rev `vault-4-00116-5kz`** (`:epoch-ui`, commit `0447c5a`) —
  `/api/metrics/epoch` gained a flow-neutral **`mtm`** block (PnL + max DD
  since epoch from the realized+equity−basis curve); `/api/metrics` gained
  `totalCapitalUsd`/`pendingDeployUsd` (vault equities + wallet cash, so the
  TVL headline no longer dips when exits park cash between rounds).
- **Web (vault-4.xyz)** now presents the entire track record from the epoch:
  merged performance panel (MTM PnL, epoch DD, `closesOriginated` trade
  stats), header uptime, PnL chart (clipped + re-based to $0), and history
  tab all anchored to 2026-07-09. Lifetime data remains in the API only.

See `packages/api/CLAUDE.md` for env vars and defaults. Still open:
recommendation 5 (the structural go/no-go question) and the manual alert
setup (Cloud Logging alert on `ALERT_`, Anthropic billing alert).
