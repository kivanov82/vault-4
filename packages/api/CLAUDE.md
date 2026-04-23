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
2. **Soft Stop-Loss** — `roePct <= -15` (`STOP_LOSS_PCT`) → full exit only if `(!isRecommended || !isAligned)`. `isAligned = vaultDirection === marketDirection || marketDirection === "neutral"`, where `vaultDirection` comes from `getVaultNetDirection` (long if net/gross > +0.2, short if < -0.2, else neutral). A recommended + aligned vault at -15% is **held**, but the iteration falls through to the inactive check below — it does not skip the rest of the loop.
3. **Inactive Vault Exit** — 0 open positions + 0 trades in last 7 days → full exit. Applies to recommended vaults too.
4. **Recommended skip** — still in recommendations after passing inactive check → leave alone.
5. **Hold Period** — non-recommended within 5 days (`MIN_HOLD_DAYS`) of last deposit → skip.
6. **Non-recommended past hold** — full exit.

**Important caveat about "recommended".** Claude is only told which vaults we already hold (`already_exposed`); it is *not* told our per-position ROE. The `vault-ranking.md` prompt instructs Claude to *prefer keeping* exposed vaults that still rank well. So a vault we are underwater on can absolutely still appear in the recommended set — there is no automatic rule that drops losing positions from recommendations. The soft-SL "recommended + aligned ⇒ hold" branch is therefore reachable.

**Deposit filtering:**
- Directional concentration limit: max 60% of new deposits in same direction (`MAX_SAME_DIRECTION_PCT`)

Wait 60s after withdrawals before deposits (configurable via `REBALANCE_WITHDRAWAL_DELAY_MS`).

**Deposits:**
- Min deposit: $5, max active vaults: 10 (`DEPOSIT_ACTIVE_COUNT`)
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
- `GET /api/history?page=1&pageSize=15` — Transaction history
- `GET /api/portfolio` — Aggregated portfolio summary
- `GET /api/metrics` — Platform metrics (TVL, 30d/60d PnL %, win rate, max drawdown)

Append `?refresh=true` to bypass cache.

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
DEPOSIT_ACTIVE_COUNT=10
DEPOSIT_HIGH_PCT=80
DEPOSIT_LOW_PCT=20
REBALANCE_WITHDRAWAL_DELAY_MS=60000
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
- Warmup: `VaultService.warm()` runs at startup when `VAULT_WARM_RECOMMENDATIONS=true`
