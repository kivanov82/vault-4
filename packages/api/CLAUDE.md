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
3. **Rebalance**: Every 2 days — take-profit withdrawals, exit non-recommended/inactive vaults, deposit into top vaults

### Rebalancing Logic

**Withdrawals (priority order):**

1. **Hard Stop-Loss** — Exit unconditionally at ROE <= -25% (`HARD_STOP_LOSS_PCT`)
2. **Soft Stop-Loss** — Exit at ROE <= -15% (`STOP_LOSS_PCT`) if vault is NOT recommended OR not aligned with market direction
3. **Inactive Vault Exits** — Withdraw ALL from vaults with 0 positions + 0 trades in 7 days (regardless of PnL)
4. **Take-Profit Partial Withdrawals** — Over-allocated recommended vaults with ROE >= 10%, withdraw excess to target
5. **Hold Period Check** — Non-recommended vaults within minimum hold period (5 days, `MIN_HOLD_DAYS`) are kept
6. **Full Exits** — All non-recommended vaults past hold period are exited unconditionally

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

Claude AI:
```
CLAUDE_MODEL=claude-3-haiku-20240307
CLAUDE_SCORING_MODEL=              # Stage 1 model (defaults to CLAUDE_MODEL)
CLAUDE_RANKING_MODEL=              # Stage 2 model (defaults to CLAUDE_MODEL)
CLAUDE_TEMPERATURE=0.2
CLAUDE_SCORING_MAX_TOKENS=4096
CLAUDE_RANKING_MAX_TOKENS=4096
CLAUDE_BATCH_SIZE=10
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
