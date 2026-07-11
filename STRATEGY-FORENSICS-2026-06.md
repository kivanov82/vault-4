# Vault-4 Strategy Forensics — 2026-06-22

> **STATUS UPDATE (2026-07-11).** Superseded by
> `STRATEGY-FORENSICS-2026-07.md` — the fresh epoch was found contaminated by
> the zombie-revision incident (Jul 2–8 traded by pre-overhaul code), §7.5
> (rotation cost hurdle) was found never shipped, and the epoch scoreboard was
> re-based to 2026-07-09. Read the July report first.

> **STATUS UPDATE (2026-07-02).** This report is a historical artifact; keep for
> context, do not treat §7 as an open action list. After the report, June chop +
> the node-outage aborted rounds (18/19) erased the remaining edge (rounds 17–23
> realized ≈ −$121; inception went negative). All §7 actions — plus three more —
> shipped on 2026-07-02 (revision `vault-4-00112-mdm`, commit `8895a88`):
> risk-only rounds on Claude failure, profit-gated trims, loss re-entry cooldown
> (`REENTRY_COOLDOWN_DAYS`), per-position ROE + our vault history fed to Claude,
> chop brake, and the gated intra-round soft-SL (now ON by default). Performance
> is now measured on a **fresh epoch** starting 2026-07-02 via
> `GET /api/metrics/epoch`; the go/no-go review is due ~2026-09/10 and should be
> judged only on that scoreboard. Details: `packages/api/CLAUDE.md`.

Forensic review of the live Hyperliquid vault-of-vaults strategy after ~5 months
of automated operation. Two data sources:

- **Ledger forensic** — `GET /api/history` (HL `getUserVaultLedgerUpdates`,
  FIFO-derived realized PnL). Full history **2026-01-23 → 2026-06-21**: 181
  deposits, 219 closes across ~95 distinct vaults.
- **Decision-logic backtest** — `scripts/backtest.ts` replaying the real
  `ExitPolicy.ts` functions over the trace DB. The trace layer only goes back to
  **round 1 (2026-05-21)**, so the backtest covers ~1 month / 17 rounds / 46
  closed episodes. Absolute backtest dollars are small; the ledger is the
  big-picture source.

---

## 1. Headline numbers (5-month ledger)

| Metric | Value | Read |
| --- | --- | --- |
| Cumulative realized PnL (FIFO) | **+$164** | Marginally positive over 5 months |
| Inception return (metrics endpoint) | **+2.38%** / 166d (~+5% annualized) | Barely above risk-free |
| Win rate (by close) | **60.8%** (132W / 85L / 2 flat) | Good hit rate |
| Avg win / avg loss | **+$8.38 / −$11.07** | **Negative skew — losses bigger than wins** |
| Profit factor | **1.17** | Thin edge |
| Expectancy per close | **+$0.75** | Pennies per trade |
| Max drawdown (metrics) | −18.9% | Plus an −86% early-era account dip at low capital |
| Current TVL | $2,496 | 11 open positions |

**Verdict:** a real but thin edge that comes *entirely from win frequency, not
win size*, repeatedly swamped by a handful of fat-tail losses — most of which
were **execution / risk failures, not selection failures.**

---

## 2. The tail is the whole story

```
WORST 5:  Otter Quant -213.46 | Realist Cap -77.86 | Singh -56.48 | Mataari -45.26 | Probot -43.70  = -$436
BEST  5:  Singh +95.02 | Orion +73.64 | +convexity +52.89 | Scared Money +52.27 | Bredo +44.00      = +$318
```

- **Otter Quant −$213** = 130% of the entire 5-month net profit, and it was a
  **pure mechanical bug**: round 7 (Jun 2) tried a hard-stop exit at −70% ROE but
  the HL vault withdrawal **filled $0.00** silently; the position rode to **−97%**
  and round 8 (Jun 4) finally realized **−$213**. This is the bug
  `WithdrawalVerifier` + `RiskMonitor` (risk-v2, mid-June) were built to kill.
  Strip it out and 5-month realized roughly *doubles* to ~+$378.
- **Realist Capital −$78** exited at **−22.3% ROE** — well past the −15% soft
  stop. Soft-SL is only evaluated at the **48h round boundary**; the intra-round
  RiskMonitor enforces *only* the −25% hard stop + trailing. A misaligned,
  non-recommended position legally bleeds −15% → −22%+ between rounds.
- **Singh / Mataari / drkmttr / Long-LINK-Short-XRP** are the **March
  pre-risk-management cohort** — the losses that originally motivated the risk
  overhauls.

Loss-severity distribution (realized loss as % of basis):

| Bucket | Count | Note |
| --- | --- | --- |
| ≤ −25% (beyond hard stop) | 5 | escaped the hard stop entirely |
| −15% to −25% | 8 | "should-have-soft-stopped" band |
| −5% to −15% | 21 | |
| 0% to −5% | 51 | **rotation churn** (see §4) |

`Singh Capital` is the cautionary tale: top-5 *winner* (+$95, +$36) **and** top-5
*loser* (−$56), net +$74. Exactly the high-variance profile the scorer rewards.

---

## 3. Selection: scoring works, but Claude flies half-blind

Pipeline: deterministic prefilter (TVL ≥ $10k, age ≥ 50d, +ve all-time PnL,
DD < 30%, margin < 50%) → **Stage-1 Claude z-score scoring** (sonnet-4-6) →
**Stage-2 Claude barbell ranking** (70/80% high-conviction, 20/30% counter-regime
hedge) → deterministic allocation with a 60% same-direction cap.

- The scorer **does** surface real momentum vaults — Orion, Scared Money, Order
  Block Hunter, +convexity, Singh, BredoStrategy all delivered $44–95 winners.
  The alpha is real.
- **But it also entered every one of the big losers at the top of the book.** The
  structural flaw (documented in `packages/api/CLAUDE.md`): **Claude is never told
  our per-position ROE / cost basis** — only *which* vaults we hold. So it keeps
  re-recommending a vault that's underwater *for us*, and the **exit logic, not
  the selection logic, has to do all the risk cleanup.** Selection and risk are
  two disconnected brains.

---

## 4. Exits: churn is taxing the edge

Rotation (`exit_not_recommended`) is the most common event type every round. Of
85 losing closes, **51 were 0 → −5%** — tiny losses from rotating positions that
hadn't done anything yet. With expectancy at **+$0.75/close** on ~$200 positions,
every unnecessary rotation pays spread against a razor-thin edge. The
`MIN_HOLD_DAYS=5` gate and 2-round hysteresis help but rotation still dominates.

There's also a **structural asymmetry in the exit rules**: every round **trims
recommended winners back to target** (no profit gate) while **losers run to the
−15%/−25% stops.** That manufactures negative skew — cap the winners, let the
losers breathe. The data confirms it: avg win $8.38 < avg loss $11.07.

---

## 5. The journey (cumulative realized PnL)

```
Jan–Feb   ramp to +$100   (early momentum)
Mar–Apr   round-trip to -$20   (Singh/LINK/drkmttr blow-ups → drove risk-mgmt v1)
Apr–May   strong recovery to +$282 peak (May 27)   ← best the strategy has looked
Jun       steady bleed +$282 → +$246 → +$180 → +$158  (Otter Quant -213 + chop, FG 12–23)
```

The strategy **makes money in trending regimes and gives it back in chop.**

---

## 6. Backtest — exit-policy sensitivity (trace window May 21 → Jun 21)

Baseline (current prod thresholds) reproduces actual to **Δ +$0.66** — the
harness is faithful.

| Policy change | Δ vs actual | Verdict |
| --- | ---: | --- |
| **Baseline** (hard −25 / soft −15 / nr 2 / trail 10·0.5) | +$0.66 | reference |
| Soft stop −15 → **−12** | **−$67** | much worse |
| Soft stop −15 → **−10** | **−$91** | much worse |
| Hard stop −25 → −20 / −18 | +$0.66 | **no effect** |
| Trailing arm 10→8, gb 0.5→0.4 | +$0.66 | net wash |
| Trailing wider (arm 12, gb 0.6) | +$0.66 | no effect |
| Less churn (nr-rounds 2 → 3) | +$0.66 | **no effect** |
| Aggressive combo (−20 / −10 / 8·0.4) | −$91 | much worse |

**Why tighter stops *lose* money — named episodes:**

```
Otter Quant   @05-29  soft@-10 exits -$23.80  vs actual $0.00   (recovered to flat)
Overdose      @06-14  soft@-10 exits -$51.71  vs actual $0.00   (recovered)
HODL My Perps @06-17  soft@-10 exits -$31.61  vs actual -$15.59 (caught a deeper trough)
```

In the June chop, positions that dipped to −10/−12% **mean-reverted** before the
live −15% line forced anything. The −15% / −25% thresholds sit *below the
vault-noise band* — that's why they avoid whipsaws. **Tightening them converts
recoverable drawdowns into locked losses.**

**The only positive single result anywhere in the grid:** IKAGI — a tighter
trailing (arm 8 / gb 0.4) would have saved **+$13.75** by locking gains before
giveback — but it's offset elsewhere to a net wash.

**The big in-window losers are unreachable by any threshold.** Realist −$78,
Mataari −$45, AILAB −$15.6 all show as **"held-longer, Δ $0.00"** — their *first*
observation below any stop level *was already their exit observation*. They fell
through the 48h grid in a single step. No threshold change catches what the grid
never saw mid-fall.

---

## 7. Lessons & prioritized actions

1. **Leave the thresholds alone.** The backtest says −15% / −25% are
   well-calibrated for the vault-noise distribution; tightening = worse. Do not
   tune reactively after a bad month.
2. **Execution reliability > selection alpha.** The single largest P&L driver —
   for and against — was withdrawal mechanics, not picking. Risk-v2 targets this;
   it's just too young (rounds 12+) to show in the numbers yet.
3. **Fix the loss source that thresholds can't reach: grid latency on genuine
   losers** (Realist −15% → −22%+ between snapshots). The fix is *more frequent
   observation, not a tighter number* — a **gated intra-round soft-SL** in
   `RiskMonitor`, restricted to *non-recommended AND misaligned AND
   still-deteriorating* positions so it catches the Realists without whipsawing
   the Overdoses. (Drafted: `RISK_MONITOR_SOFT_SL_ENABLED`, default off.)
4. **Feed Claude per-position ROE / basis** so it stops re-recommending our
   underwater bags — the root cause of why losers stay "recommended" and dodge
   the soft stop in the first place.
5. **Churn is a tax on a 1.17 profit factor.** The backtest is blind to
   spread/fee cost (it only sees realized fills), so this stays a ledger-level
   lesson: rotation should require the replacement's edge to clearly exceed the
   incumbent's *plus* round-trip cost — not just a marginally higher score.

### Things explicitly NOT worth doing (backtest-disproven)
- Tightening soft or hard stop-loss thresholds.
- Changing the hysteresis / `nr-rounds` churn gate (inert in-window).
- Re-tuning the trailing stop (net wash).
