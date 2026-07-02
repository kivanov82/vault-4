# CLAUDE.md — API Package

This is the **backend API** (`packages/api/`) within the vault-4 monorepo. The frontend UI lives at `packages/web/`.

## Overview

Vault-4 API is a fully automated, non-custodial trading platform for Hyperliquid vaults. It uses Claude AI to rank deposit-open vaults using market-aware algorithms, then executes automated 2-day rebalancing cycles to optimize capital allocation.

## Commands

```bash
npm run dev           # Development mode with hot-reload (nodemon + ts-node)
npm run start         # Production run (ts-node src/index.ts)
npm run test          # Run Jest tests
npm run docker-build  # Build Docker image
npm run docker-push   # Push to GCP container registry
```

**Ports:** Dev server runs on `3000`, Docker exposes `8080`.

## Architecture

```
src/
  index.ts                           # Express 5 entry point, API endpoints
  service/
    Vault4.ts                        # Main service initialization
    trade/
      HyperliquidConnector.ts        # Hyperliquid API wrapper
    vaults/
      VaultService.ts                # Vault discovery, ranking, metrics, portfolio
      types.ts                       # TypeScript type definitions
    rebalance/
      RebalanceScheduler.ts          # 2-day interval scheduler
      RebalanceOrchestrator.ts       # Rebalancing orchestration
      RebalanceService.ts            # Deposit/withdraw execution
      DepositService.ts              # Deposit plan building (barbell strategy)
      ExitPolicy.ts                  # Shared exit thresholds + pure decision helpers
      RiskMonitor.ts                 # Intra-round (4h) hard-SL / trailing-stop checks
      TrailingStopService.ts         # Peak-ROE tracking (position_peak) + giveback exits
      WithdrawalVerifier.ts          # Withdrawal fill verification + zero-fill retries
    claude/
      ClaudeService.ts               # Claude API integration for two-stage vault ranking
      MarketDataService.ts           # Market overlay data fetching
      portfolioContext.ts            # Per-position ROE + our vault history fed to both stages
      prompts/
        vault-scoring.md             # Stage 1: Batch scoring prompt (0-100)
        vault-ranking.md             # Stage 2: Final ranking with allocations
    utils/
      logger.ts                      # Custom JSON-based logger
```

### Core Flow

1. **Discover**: Filter candidate vaults via Hyperliquid API
   - Filters: TVL, age, followers, trades in last 7 days, deposits open
   - Vaults with 0 current positions are excluded (prevents dead vaults)
2. **Rank** (two-stage):
   - **Stage 1**: Score vaults in batches (`vault-scoring.md` prompt, returns 0-100 scores)
   - **Stage 2**: Top candidates ranked for final allocation (`vault-ranking.md` prompt, returns barbell allocation)
3. **Rebalance**: Every 2 days — trim over-allocated recommended vaults, exit non-recommended/inactive/SL vaults, deposit into top vaults

### Rebalancing Logic

**Round degradation (risk-only rounds).** If Claude ranking fails (heuristic fallback), the round does NOT abort anymore — it degrades to a **risk-only round**: every protective exit still runs (hard SL, soft SL against the last known recommendation set — in-memory stash with a DB fallback to the persisted stage-2 `claude_decision` — trailing stop, inactive vault) with full fill verification, while trims, rotation, and deposits are skipped. Recorded as `status=completed` with `summary_json.mode="risk-only"`. This closes the 2026-06-23→25 outage hole where full aborts left the book unmanaged for ~5 days (round 21 then realized −$103 in one cleanup).

**Chop brake.** After fetching the market direction, the round compares it to the previous completed round's direction (`readRecentRoundDirections`). If the current direction is `neutral` or differs from the previous one (`isChopRegime` in `ExitPolicy.ts`), the round is a **chop round**: all planned deposits (new slots + top-ups) are scaled by `CHOP_DEPOSIT_FACTOR` (default 0.5), and non-risk rotation of profitable/flat positions is deferred (`hold_chop` events — they neither increment nor reset the hysteresis streak; the rotation clock freezes). Stop-losses, trailing stops, and losing-position rotation are unaffected. Rationale: the ledger shows the strategy earns in trends and bleeds in chop; direction flip-flopping is the observable symptom.

Each round runs two passes in this order:

**Pass 1 — Trim over-allocated recommended vaults to barbell target (profit-gated).**
For every current position still in the Claude recommendation set with `currentUsd > targetUsd`, a partial withdrawal back to `targetUsd` fires only if `shouldTrim` passes: ROE ≥ `TRIM_MIN_ROE_PCT` (default 0 — never realize a partial loss via trim) AND the position is over target by ≥ `TRIM_OVERWEIGHT_TOLERANCE_PCT` (default 25%, mirroring the top-up tolerance). The old unconditional every-round trim was one of the two mechanisms manufacturing the ledger's negative skew (avg win $8.38 vs avg loss $11.07): winners were clipped back to target every 48h while losers rode to the stops. **No hold-period gate** — a vault funded today can be trimmed today if it passes the gate.

**Pass 2 — Withdrawal scan, evaluated per position in this exact order:**

1. **Hard Stop-Loss** — `roePct <= -25` (`HARD_STOP_LOSS_PCT`) → full exit, unconditional.
2. **Soft Stop-Loss** — `roePct <= -15` (`STOP_LOSS_PCT`) → full exit only if `(!isRecommended || !isAligned)`. `isAligned = vaultDirection === marketDirection || marketDirection === "neutral"`, where `vaultDirection` comes from `getVaultNetDirection` (long if net/gross > +0.2, short if < -0.2, else neutral). A recommended + aligned vault at -15% is **held**, but the iteration falls through to the trailing/inactive checks below — it does not skip the rest of the loop.
3. **Trailing Stop** — every position's ROE ratchets a high-water in `position_peak` (shared with RiskMonitor). Once the peak reaches `TRAILING_STOP_ARM_ROE_PCT` (default +10), giving back more than `TRAILING_STOP_GIVEBACK_RATIO` (default 0.5) of the peak → full exit. Ignores hold period and recommendation status. Peaks are deleted on full exit (per-episode).
4. **Inactive Vault Exit** — 0 open positions + 0 trades in last 7 days → full exit. Applies to recommended vaults too.
5. **Recommended skip** — still in recommendations after passing inactive check → leave alone.
6. **Hold Period** — non-recommended within 5 days (`MIN_HOLD_DAYS`) of last deposit → skip.
7. **Chop-brake deferral** — on a chop round, a non-recommended position with `roePct >= 0` records `hold_chop` and is left alone (rotation deferred; hysteresis streak frozen). Losing positions fall through to the next rule unchanged.
8. **Non-recommended past hold** — hysteresis: a position with `roePct >= 0` is held for `NOT_RECOMMENDED_EXIT_ROUNDS` (default 2) consecutive non-recommended rounds (`hold_not_recommended` events count the streak; any recommended-round event resets it) before the full exit. Losing positions exit on the first non-recommended round. If the trace DB is unreachable the pre-hysteresis behavior applies (exit immediately).

**Withdrawal fill verification (`WithdrawalVerifier.ts`):** after submitting withdrawals, per-vault equity is polled against the expected post-withdrawal level (0 for full exits, the trim target for trims). Withdrawals that didn't move equity by the deadline are re-submitted up to `WITHDRAWAL_VERIFY_MAX_RETRIES` (default 2) times, recording `exit_retry`/`trim` trace events. HL can fill a vault withdrawal for $0 when the vault has no free margin — previously this went undetected for a full round (the 2026-06 Otter Quant -$213 loss).

**RiskMonitor (`RiskMonitor.ts`):** between rounds, every `RISK_MONITOR_INTERVAL_MS` (default 4h, first tick 10 min after boot) re-checks all open positions and fires protective exits only: hard stop-loss (`exit_risk_monitor`) and trailing stop (`exit_trailing_stop`), with the same fill verification. It also fires (on by default; kill switch `RISK_MONITOR_SOFT_SL_ENABLED=false`) a **gated soft stop-loss** (`exit_soft_sl`, `round_id=null`) for a position that is below `STOP_LOSS_PCT` **and** absent from the last known recommendation set (`resolveRecommendedSet` — in-memory stash with a DB fallback to the persisted stage-2 `claude_decision`, so restarts don't blind it) **and** mis-aligned with the market overlay direction **and** still falling vs the previous tick's ROE (tracked in-memory per held vault). This stricter AND-gate exists because the 2026-06 backtest showed a blanket intra-round soft stop whipsaws recoverable dips; the gate isolates the Realist-Capital profile (abandoned + counter-regime + confirmed-losing) that the 48h round scan lets bleed −15% → −22%. It declines to fire when the recommendation set is empty/stale (`RISK_MONITOR_RECOMMENDED_MAX_AGE_MS`) or the regime is neutral. Full rotation still needs the live Claude ranking and stays in the round scan. Skips a tick if a rebalance round is running. Disabled via `RISK_MONITOR_ENABLED=false` (or `REBALANCE_ENABLED=false`).

**Portfolio context fed to Claude (`portfolioContext.ts`).** Both ranking stages now receive, alongside `already_exposed`: `current_positions` (per-position `current_usd`, `roe_pct` vs OUR FIFO cost basis, `hold_days`), `our_vault_history` (per-vault episodes + realized PnL from `position_account`), and `recently_exited_at_loss` (the re-entry cooldown list). The prompts instruct Claude to (a) never boost a vault for being held, (b) treat repeated realized losses as negative evidence, (c) DROP an incumbent that is ≤ −10% ROE for us unless it is top-~8 on pure merit — keeping a loser "recommended" blocks the soft stop-loss — and (d) require a challenger to beat an incumbent by > 0.5 robust-z (estimated rotation round-trip cost) before rotating. All DB-derived fields degrade to empty arrays when the trace layer is down (old bare-addresses behavior). This closes the forensics §3 flaw where selection and risk were two disconnected brains.

**Deposit filtering:**
- Directional concentration limit: max 60% of new deposits in same direction (`MAX_SAME_DIRECTION_PCT`)
- **Loss re-entry cooldown**: vaults we fully exited at a realized loss (< −$0.50) within `REENTRY_COOLDOWN_DAYS` (default 10) receive no NEW deposits even if re-recommended (2026-06 failure mode: Overdose exited −$39.61 on 06-21, re-entered $254 on 06-26). Top-ups of held positions are unaffected. Fail-open when the trace DB is down.
- **Chop rounds**: every planned deposit is scaled by `CHOP_DEPOSIT_FACTOR`; the unspent balance deploys on the next confirmed-trend round.

Wait 60s after withdrawals before deposits (configurable via `REBALANCE_WITHDRAWAL_DELAY_MS`).

**Deposits:**
- Min deposit: $5, max active vaults: 11 (`DEFAULT_MAX_ACTIVE`; 8 high / 3 low)
- New-slot deposits go only into NEW vaults (no existing exposure); a top-up pass (`REBALANCE_TOPUP_ENABLED`, on by default) additionally tops up held recommended vaults ≥30% under Claude's target — new slots take budget priority
- Barbell-weighted allocation: high-confidence group gets 70-80%, low-confidence gets 20-30%
- Positions < $1 excluded from vault count (dust filtering)
- Balance from Hyperliquid clearinghouse `withdrawable` field

### Key Patterns

- **Services**: Static methods, singletons under `src/service/`
- **Caching**: Vault cache 5min, portfolio 2min, market data 60s
- **Two-Stage Ranking**: Batches of 10 scored, then top 12 ranked for final allocation
- **Market data overlay**: BTC/ETH price changes, funding rates, OI, volume, long/short ratio

## API Endpoints

- `GET /health` — Health check
- `GET /api/positions` — User vault positions
- `GET /api/history?page=1&pageSize=15` — Transaction history (reads from `position_ledger`, falls back to live HL if DB empty)
- `GET /api/portfolio` — Aggregated portfolio summary
- `GET /api/metrics` — Platform metrics (TVL, 30d/60d PnL %, win rate, max drawdown)
- `GET /api/metrics/epoch` — Fresh-epoch strategy KPIs, computed strictly from ledger activity at/after `METRICS_EPOCH_START` (2026-07-02, the risk/selection overhaul): per-close realized PnL via the same FIFO replay as `position_account` (pre-epoch basis carried in correctly), win rate, avg win/loss, **winLossRatio** (skew — lifetime was 0.76, target > 1), profit factor, expectancy/close, churn closes (0–5%-of-basis losses), deposits, round counts (incl. risk-only), event counts by action. This is the scoreboard for the 2-3 month go/no-go review — do not judge the overhaul on lifetime metrics.
- `GET /api/trace/rounds?limit=20` — Recent rebalance rounds with summaries
- `GET /api/trace/rounds/:id` — Round detail: market snapshot + Claude decisions + vault snapshots + position events
- `GET /api/trace/positions/:vaultAddress?limit=100` — Chronological event timeline per vault

Append `?refresh=true` to bypass cache.

## Trace persistence layer (`src/db/`)

Cloud SQL Postgres mirrors every position lifecycle event the orchestrator causes, the Claude
Stage 2 output per round, the market overlay snapshot, and per-vault context at decision time.
The HL `getUserVaultLedgerUpdates` ledger is mirrored into `position_ledger` and a derived
`position_account` table that uses **our-own FIFO basis** — HL's `basisUsd` is stored only as
`basis_usd_hl` for divergence audit and is never used in any logic.

- Schema: `migrations/*.sql` (001 init → 005 chop brake). Migrations run on startup via `runMigrations()` in `Vault4.init()`.
- FIFO math: `src/db/PositionAccountService.ts` (pure, unit-tested in `src/db/__tests__/`).
- Fresh-epoch KPIs: `src/db/EpochKpiService.ts` — full-ledger FIFO replay, stats filtered to closes at/after `METRICS_EPOCH_START` (serves `/api/metrics/epoch`).
- Trace writes are non-fatal — DB outages must never break a rebalance round.
- Periodic ledger sync every 5 min (`LEDGER_SYNC_INTERVAL_MS`).

### Scripts

```bash
# One-time HL ledger backfill into position_ledger + recompute position_account
npx ts-node scripts/backfill-ledger.ts

# Backfill HL portfolio time series (pnlHistory + accountValueHistory) into portfolio_series,
# plus our-own realized PnL + open basis per timestamp
npx ts-node scripts/backfill-series.ts

# Decision-logic backtest: replay exit policy with alternative thresholds
# against /api/trace history (HTTP, no DB creds). Same ExitPolicy.ts functions
# as production. --nr-rounds 1 --trailing-arm 9999 reproduces the pre-2026-06
# policy exactly (validated: Δ $0.00 vs actual realized).
npx ts-node scripts/backtest.ts --base-url https://vault-4-s6qnbk6izq-ew.a.run.app \
  --hard-sl -25 --soft-sl -15 --nr-rounds 2 --trailing-arm 10 --trailing-giveback 0.5
```

## X (Twitter) posting

Daily auto-posting via `XPostScheduler` (`src/service/social/`). Independent of
settlement, jittered cadence — picks a random delay between `X_POST_MIN_HOURS`
and `X_POST_MAX_HOURS` (default 14-34h) so the post time drifts across the day.

Content types in `CONTENT_MIX`:
- **Educational** — `concept_perp_funding`, `concept_open_interest`, `concept_basis_carry`, `concept_long_short_skew`, `concept_liquidations`
- **Market reaction** — `market_funding_signal`, `market_oi_buildup`, `market_sentiment_extreme`, `market_hyperliquid_flow`
- **Performance (positive only)** — `perf_weekly_positive`, `perf_monthly_positive`, `perf_inception_positive`, `perf_top_token` (with `#TICKER` hashtag)
- **Engine internals** — `engine_ranking`, `engine_rebalance`, `engine_risk`, `engine_market_overlay`
- **News reaction** — `news_react` (gated on at least one keyword-relevant hot topic returning from `NewsService`)

Topic-specific gating in `pickContentTypeForContext` — `perf_*` topics only enter the pool when the underlying metric is positive; `news_react` only when CryptoPanic returned actual headlines.

**Persona rule:** the prompt forbids the word "vault". The bot speaks as a perps trader running an AI strategy — never mentions VAULT-4 by name. A code-level guardrail drops generated tweets that slip a "vault" word through.

News sources for `news_react`: free RSS (Cointelegraph, Decrypt, The Defiant, DLNews) + Reddit JSON (`r/Hyperliquid`, `r/CryptoCurrency`, `r/ethfinance`). No API keys. Cached 30 min.

Env vars: `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`, `X_POST_ENABLED`, `X_POST_MIN_HOURS`, `X_POST_MAX_HOURS`.

## Environment Variables

Required:
```
ANTHROPIC_API_KEY=<key>
WALLET=0x<user-address>
WALLET_PK=0x<private-key>
```

Claude AI (single model used for every Claude call — Stage 1, Stage 2, articles, X posts):
```
CLAUDE_MODEL=claude-sonnet-4-6
CLAUDE_TEMPERATURE=0.2
CLAUDE_SCORING_MAX_TOKENS=8192
CLAUDE_RANKING_MAX_TOKENS=8192
CLAUDE_BATCH_SIZE=5
CLAUDE_FINAL_RANKING_LIMIT=12
CLAUDE_API_DELAY_MS=60000
CLAUDE_MAX_TRADES_PER_VAULT=50
CLAUDE_MAX_POSITIONS_PER_VAULT=30
CLAUDE_MAX_PNL_POINTS=60
```

Vault filtering:
```
VAULT_MIN_TVL=10000
VAULT_MIN_AGE_DAYS=50
VAULT_MIN_FOLLOWERS=10
VAULT_MIN_TRADES_7D=5
VAULT_REQUIRE_POSITIVE_WEEKLY_PNL=false
VAULT_REQUIRE_POSITIVE_MONTHLY_PNL=false
```

Rebalancing:
```
DEPOSIT_ACTIVE_COUNT=11
DEPOSIT_HIGH_PCT=80
DEPOSIT_LOW_PCT=20
REBALANCE_WITHDRAWAL_DELAY_MS=60000
# Exit policy (ExitPolicy.ts defaults)
STOP_LOSS_PCT=-15
HARD_STOP_LOSS_PCT=-25
MIN_HOLD_DAYS=5
NOT_RECOMMENDED_EXIT_ROUNDS=2
TRAILING_STOP_ENABLED=true
TRAILING_STOP_ARM_ROE_PCT=10
TRAILING_STOP_GIVEBACK_RATIO=0.5
# Profit-gated trims (skew fix, 2026-07): only trim a recommended position
# when its ROE >= TRIM_MIN_ROE_PCT AND it is over target by more than
# TRIM_OVERWEIGHT_TOLERANCE_PCT. TRIM_MIN_ROE_PCT=-100 +
# TRIM_OVERWEIGHT_TOLERANCE_PCT=0 restores the old unconditional trim.
TRIM_MIN_ROE_PCT=0
TRIM_OVERWEIGHT_TOLERANCE_PCT=25
# Loss re-entry cooldown (churn fix, 2026-07): no new deposits into a vault
# we exited at a realized loss within this many days. 0 disables.
REENTRY_COOLDOWN_DAYS=10
# Chop brake (regime fix, 2026-07): when market direction is neutral or just
# flipped vs the previous completed round, scale deposits by
# CHOP_DEPOSIT_FACTOR and defer non-risk rotation of profitable positions.
CHOP_BRAKE_ENABLED=true
CHOP_DEPOSIT_FACTOR=0.5
# Fresh-epoch KPI scoreboard (/api/metrics/epoch) measures from this instant.
METRICS_EPOCH_START=2026-07-02T00:00:00Z
# Intra-round risk monitor
RISK_MONITOR_ENABLED=true
RISK_MONITOR_INTERVAL_MS=14400000
RISK_MONITOR_INITIAL_DELAY_MS=600000
RISK_MONITOR_SETTLE_WAIT_MS=60000
# Gated intra-round soft stop-loss (ON by default; kill switch
# RISK_MONITOR_SOFT_SL_ENABLED=false). A RiskMonitor tick also fires a soft-SL
# (`exit_soft_sl`, round_id=null) for a position that is below STOP_LOSS_PCT AND
# dropped from Claude's last recommendation set AND trading against the regime
# AND still falling vs the previous tick. The strict AND-gate (vs the round
# scan's `!rec || !aligned`) plus the "still falling" check avoid the
# mean-reversion whipsaw the 2026-06 backtest flagged when soft stops were
# tightened. Closes the 48h-latency bleed (Realist Capital -$78).
RISK_MONITOR_SOFT_SL_ENABLED=true
RISK_MONITOR_RECOMMENDED_MAX_AGE_MS=259200000
# Withdrawal fill verification
WITHDRAWAL_VERIFY_MAX_RETRIES=2
# Round-end chart stamp: poll getUserVaultEquities until vault equity settles
# (HL credits just-submitted deposits with a few-min lag) before stamping the
# portfolio_series point, so the chart never freezes a pre-deposit equity.
REBALANCE_STAMP_POLL_MS=45000
REBALANCE_STAMP_MAX_WAIT_MS=300000
# Global HL REST rate limiter (RateLimiter.ts). HL enforces 1200 request-weight
# per minute per IP, aggregated across info+exchange. A single process-wide
# weighted token bucket gates EVERY HL call (SDK transports via their onRequest
# hook + the raw axios /info posts), so fan-out sites (snapshot refresh,
# candidate discovery, settlement, X-post) can no longer collectively overshoot
# and trigger 429s. A 429 from any path drains the bucket and pauses the whole
# fleet for the cooldown (honoring Retry-After). Execution traffic (withdrawals,
# deposits) runs at a higher priority lane than background polling.
HL_RATE_WEIGHT_PER_MIN=960
HL_RATE_BURST=120
HL_RATE_PENALTY_MS=10000
# Per-vault read caches (HyperliquidConnector.ts). Must outlive the 5-min
# platform snapshot refresh so consecutive refreshes + the candidate-discovery
# loop reuse cached vault data instead of re-fetching every vault every cycle
# (which dominated the rate budget once the limiter started pacing). Defaults
# 10 min; slow-moving data (followers, allowDeposits, TVL/pnl history, vault
# positions/margin) so minutes of staleness is fine on a 2-day rebalance cycle.
# Does NOT touch our-equity/withdrawal reads (those use getUserVaultEquities).
VAULT_DETAILS_TTL_MS=600000
VAULT_ACCOUNT_SUMMARY_TTL_MS=600000
```

## Deployment

Google Cloud Run. Dockerfile in this package root. Exposes port 8080.

**IMPORTANT:** Cloud Run requires a single-platform `linux/amd64` image. Use `--provenance=false` to avoid OCI index wrapper that Cloud Run rejects.

```bash
docker buildx build --platform=linux/amd64 --provenance=false --output type=docker -t gcr.io/bright-union/vault-4:latest .
docker push gcr.io/bright-union/vault-4:latest
```

Then deploy the new revision via Cloud Console or `gcloud run deploy`.

## Conventions

- TypeScript services under `src/service/`; keep async Hyperliquid calls paced
- Use the `logger` module: `logger.info("msg", { context: "data" })`
- Types centralized in `src/service/vaults/types.ts`
- TypeScript strict mode is disabled (`"strict": false` in tsconfig.json)

## Gotchas

- PnL metrics (`pnlChange30dPct`, `pnlChange60dPct`) are calculated from realized vault withdrawal ledger entries only (not unrealized)
- Max drawdown (`maxDrawdownPct`) is pro rata across all vaults: active vaults use per-user account value history; closed vaults use vault-level history filtered to investment period
