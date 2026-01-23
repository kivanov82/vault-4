# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Vault-4 is a fully automated, non-custodial trading platform for Hyperliquid vaults. It uses OpenAI to rank deposit-open vaults using market-aware algorithms, then executes automated 2-day rebalancing cycles to optimize capital allocation.

## Commands

```bash
npm run dev           # Development mode with hot-reload (nodemon + ts-node)
npm run start         # Production run (ts-node src/index.ts)
npm run test          # Run Jest tests (none defined yet)
npm run docker-build  # Build Docker image
npm run docker-push   # Push to GCP container registry
```

## Architecture

```
src/
├── index.ts                           # Express 5 entry point, API endpoints
├── service/
│   ├── Vault4.ts                      # Main service initialization
│   ├── trade/
│   │   └── HyperliquidConnector.ts    # Hyperliquid API wrapper
│   ├── vaults/
│   │   ├── VaultService.ts            # Vault discovery, ranking, recommendations
│   │   └── types.ts                   # TypeScript type definitions
│   ├── rebalance/
│   │   ├── RebalanceScheduler.ts      # 2-day interval scheduler
│   │   ├── RebalanceOrchestrator.ts   # Rebalancing orchestration
│   │   ├── RebalanceService.ts        # Deposit/withdraw execution
│   │   └── DepositService.ts          # Deposit plan building (barbell strategy)
│   ├── openai/
│   │   ├── OpenAIService.ts           # GPT integration for two-stage vault ranking
│   │   ├── MarketDataService.ts       # Market overlay data fetching
│   │   └── prompts/
│   │       ├── vault-scoring.md       # Stage 1: Batch scoring prompt (0-100)
│   │       └── vault-ranking.md       # Stage 2: Final ranking with allocations
│   └── utils/
│       └── logger.ts                  # Custom JSON-based logger
```

### Core Flow

1. **Discover**: Filter candidate vaults via Hyperliquid API (TVL, age, followers, etc.)
2. **Rank** (two-stage):
   - **Stage 1**: Score vaults in parallel batches of 20 (`vault-scoring.md` prompt, returns 0-100 scores)
   - **Stage 2**: Take top candidates from all batches, run final ranking (`vault-ranking.md` prompt, returns barbell allocation)
3. **Rebalance**: Every 2 days, withdraw from non-recommended vaults (positive PnL only), deposit into top vaults

### Rebalancing Logic

The rebalancing cycle runs every 2 days and follows these rules:

**Withdrawals:**
- Only withdraw from vaults no longer in recommendations
- Only withdraw if position has positive PnL (never realize losses)

**Deposits:**
- Only deposit to NEW vaults (no existing exposure) to avoid concentration risk
- Available balance (perps wallet) is split between high/low confidence groups
- Default split: 80% to high-confidence vaults, 20% to low-confidence
- Each group's allocation is split evenly among vaults in that group
- If one group is empty, its allocation goes to the other group

**Example:**
- Available balance: $10,000
- High-confidence vaults (no exposure): 4 vaults → $8,000 / 4 = $2,000 each
- Low-confidence vaults (no exposure): 2 vaults → $2,000 / 2 = $1,000 each
- Vaults with existing exposure: skipped entirely

### Key Patterns

- **Services**: Static methods, singletons under `src/service/`
- **Caching**: Multiple TTL configs (vault cache 5min, portfolio 2min, market data 60s)
- **Barbell Strategy**: 70-80% to high-confidence vaults, 20-30% to low-confidence
- **Two-Stage Ranking**: Batches of 20 vaults scored in parallel, then top candidates ranked for final allocation. Configurable via `OPENAI_BATCH_SIZE` (default 20), with richer data per vault (`OPENAI_MAX_TRADES_PER_VAULT=50`, `OPENAI_MAX_POSITIONS_PER_VAULT=30`, `OPENAI_MAX_PNL_POINTS=60`)

## Environment Variables

Required (no defaults):
```
OPENAI_API_KEY=<key>
WALLET=0x<user-address>
WALLET_PK=0x<private-key>
```

## Conventions

- TypeScript services under `src/service/`; keep async Hyperliquid calls paced
- Use the `logger` module with context: `logger.info("msg", { context: "data" })`
- OpenAI payloads include `already_exposed` vaults and expect barbell allocation output
- Types centralized in `src/service/vaults/types.ts` - key types: `RecommendationSet`, `DepositPlan`, `VaultCandidate`
- Prefer ASCII in files unless the file already uses Unicode

## API Endpoints

- `GET /health` - Health check
- `GET /api/positions` - User vault positions
- `GET /api/history?page=1&pageSize=15` - Transaction history
- `GET /api/portfolio` - Aggregated portfolio summary
- `GET /api/metrics` - Platform metrics (TVL, 30d PnL %, win rate, max drawdown)

Add `?refresh=true` to bypass cache.

## Notes

- 30D performance uses `pnlChange30dPct` derived from PnL history, not TVL change
- Warmup: `VaultService.warm()` runs at startup when `VAULT_WARM_RECOMMENDATIONS=true`
- Withdrawals only from positive-PnL vaults no longer recommended

## ToDos
- move from OpenAI to Claude API
