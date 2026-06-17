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

Each round runs two passes in this order:

**Pass 1 — Trim over-allocated recommended vaults to barbell target.**
For every current position that is still in the Claude recommendation set: if `currentUsd > targetUsd`, partial-withdraw the excess back to `targetUsd`. **No profit threshold** — trims fire whenever Claude says we're overweight, regardless of ROE. **No hold-period gate** — a vault funded today can be trimmed today if it's already over target.

**Pass 2 — Withdrawal scan, evaluated per position in this exact order:**

1. **Hard Stop-Loss** — `roePct <= -25` (`HARD_STOP_LOSS_PCT`) → full exit, unconditional.
2. **Soft Stop-Loss** — `roePct <= -15` (`STOP_LOSS_PCT`) → full exit only if `(!isRecommended || !isAligned)`. `isAligned = vaultDirection === marketDirection || marketDirection === "neutral"`, where `vaultDirection` comes from `getVaultNetDirection` (long if net/gross > +0.2, short if < -0.2, else neutral). A recommended + aligned vault at -15% is **held**, but the iteration falls through to the trailing/inactive checks below — it does not skip the rest of the loop.
3. **Trailing Stop** — every position's ROE ratchets a high-water in `position_peak` (shared with RiskMonitor). Once the peak reaches `TRAILING_STOP_ARM_ROE_PCT` (default +10), giving back more than `TRAILING_STOP_GIVEBACK_RATIO` (default 0.5) of the peak → full exit. Ignores hold period and recommendation status. Peaks are deleted on full exit (per-episode).
4. **Inactive Vault Exit** — 0 open positions + 0 trades in last 7 days → full exit. Applies to recommended vaults too.
5. **Recommended skip** — still in recommendations after passing inactive check → leave alone.
6. **Hold Period** — non-recommended within 5 days (`MIN_HOLD_DAYS`) of last deposit → skip.
7. **Non-recommended past hold** — hysteresis: a position with `roePct >= 0` is held for `NOT_RECOMMENDED_EXIT_ROUNDS` (default 2) consecutive non-recommended rounds (`hold_not_recommended` events count the streak; any recommended-round event resets it) before the full exit. Losing positions exit on the first non-recommended round. If the trace DB is unreachable the pre-hysteresis behavior applies (exit immediately).

**Withdrawal fill verification (`WithdrawalVerifier.ts`):** after submitting withdrawals, per-vault equity is polled against the expected post-withdrawal level (0 for full exits, the trim target for trims). Withdrawals that didn't move equity by the deadline are re-submitted up to `WITHDRAWAL_VERIFY_MAX_RETRIES` (default 2) times, recording `exit_retry`/`trim` trace events. HL can fill a vault withdrawal for $0 when the vault has no free margin — previously this went undetected for a full round (the 2026-06 Otter Quant -$213 loss).

**RiskMonitor (`RiskMonitor.ts`):** between rounds, every `RISK_MONITOR_INTERVAL_MS` (default 4h, first tick 10 min after boot) re-checks all open positions and fires protective exits only: hard stop-loss (`exit_risk_monitor`) and trailing stop (`exit_trailing_stop`), with the same fill verification. Soft-SL and rotation need Claude context and stay in the round scan. Skips a tick if a rebalance round is running. Disabled via `RISK_MONITOR_ENABLED=false` (or `REBALANCE_ENABLED=false`).

**Important caveat about "recommended".** Claude is only told which vaults we already hold (`already_exposed`); it is *not* told our per-position ROE. The `vault-ranking.md` prompt instructs Claude to *prefer keeping* exposed vaults that still rank well. So a vault we are underwater on can absolutely still appear in the recommended set — there is no automatic rule that drops losing positions from recommendations. The soft-SL "recommended + aligned ⇒ hold" branch is therefore reachable.

**Deposit filtering:**
- Directional concentration limit: max 60% of new deposits in same direction (`MAX_SAME_DIRECTION_PCT`)

Wait 60s after withdrawals before deposits (configurable via `REBALANCE_WITHDRAWAL_DELAY_MS`).

**Deposits:**
- Min deposit: $5, max active vaults: 11 (`DEFAULT_MAX_ACTIVE`; 8 high / 3 low)
- Only NEW vaults (no existing exposure)
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

- Schema: `migrations/001_init.sql`. Migrations run on startup via `runMigrations()` in `Vault4.init()`.
- FIFO math: `src/db/PositionAccountService.ts` (pure, unit-tested in `src/db/__tests__/`).
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
CLAUDE_SCORING_MAX_TOKENS=4096
CLAUDE_RANKING_MAX_TOKENS=4096
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
# Intra-round risk monitor
RISK_MONITOR_ENABLED=true
RISK_MONITOR_INTERVAL_MS=14400000
RISK_MONITOR_INITIAL_DELAY_MS=600000
RISK_MONITOR_SETTLE_WAIT_MS=60000
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
