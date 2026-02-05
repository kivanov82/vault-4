# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Vault-4 is a fully automated, non-custodial trading platform for Hyperliquid vaults. It uses Claude AI to rank deposit-open vaults using market-aware algorithms, then executes automated 2-day rebalancing cycles to optimize capital allocation.

## Related Projects

| Project | Path | Purpose |
|---------|------|---------|
| **vault-4** (this repo) | `/Users/kirilivanov/DEV/vault-4` | Backend API service - vault discovery, ranking, and automated rebalancing |
| **vault-4-App** | `/Users/kirilivanov/DEV/vault-4-App` | Frontend UI - displays portfolio, positions, metrics, and transaction history |

The UI consumes the API endpoints defined in this backend service. When making API changes, ensure compatibility with the frontend.

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
│   ├── claude/
│   │   ├── ClaudeService.ts           # Claude API integration for two-stage vault ranking
│   │   ├── MarketDataService.ts       # Market overlay data fetching
│   │   └── prompts/
│   │       ├── vault-scoring.md       # Stage 1: Batch scoring prompt (0-100)
│   │       └── vault-ranking.md       # Stage 2: Final ranking with allocations
│   └── utils/
│       └── logger.ts                  # Custom JSON-based logger
```

### Core Flow

1. **Discover**: Filter candidate vaults via Hyperliquid API
   - Filters: TVL, age, followers, trades in last 7 days, deposits open
   - **Active positions check**: Vaults with 0 current positions are excluded (prevents dead vaults)
2. **Rank** (two-stage):
   - **Stage 1**: Score vaults in parallel batches of 20 (`vault-scoring.md` prompt, returns 0-100 scores)
   - **Stage 2**: Take top candidates from all batches, run final ranking (`vault-ranking.md` prompt, returns barbell allocation)
3. **Rebalance**: Every 2 days, execute take-profit withdrawals, exit non-recommended/inactive vaults, deposit into top vaults

### Rebalancing Logic

The rebalancing cycle runs every 2 days and follows these rules:

**Withdrawals (executed in priority order):**

1. **Inactive Vault Exits** (highest priority):
   - Withdraw ALL positions from vaults with 0 positions AND 0 trades in last 7 days
   - Applied regardless of PnL (positive or negative) or recommendation status
   - Prevents capital being locked in dead/abandoned vaults

2. **Take-Profit Partial Withdrawals**:
   - For vaults still in recommendations but over-allocated
   - Only if position ROE >= 10%
   - Withdraw excess to bring position back to target allocation
   - Locks in gains while maintaining exposure

3. **Full Exits from Non-Recommended Vaults**:
   - Only withdraw from vaults no longer in recommendations
   - Only withdraw if position ROE >= 2% (prevents realizing small losses)
   - Wait 60s after withdrawals before deposits (configurable via `REBALANCE_WITHDRAWAL_DELAY_MS`)

**Deposits:**
- **Minimum deposit**: $5 USD (deposits below this are skipped)
- **Max active vaults**: 10 (configurable via `DEPOSIT_ACTIVE_COUNT`)
- **Dust filtering**: Positions < $1 are excluded from vault count (prevents dust from blocking new deposits)
- **Available balance**: Fetched from Hyperliquid clearinghouse `withdrawable` field (perps wallet balance)
- Only deposit to NEW vaults (no existing exposure) to avoid concentration risk
- New deposits are limited by available slots: `maxActive - currentVaultCount`
- **Barbell-weighted allocation**: New vaults receive their barbell-weighted share based on confidence level
  - High confidence target: `totalCapital * (highPct / 100) / highCount` (e.g., 70% / 5 = 14% each)
  - Low confidence target: `totalCapital * (lowPct / 100) / lowCount` (e.g., 30% / 5 = 6% each)
  - `availableForDeposit = min(perpsBalance, totalAllocationNeeded)`
  - If balance is insufficient, allocations are scaled down proportionally
- Each vault in a confidence group gets equal share within that group
- If one group is empty, its allocation goes to the other group
- Deposits continue even if individual deposits fail (no cascading failures)

**Example 1 (barbell allocation):**
- Total capital: $600, recommendations: 5 high / 5 low, barbell split: 70/30
- High confidence target per vault: $600 * 70% / 5 = **$84** (14%)
- Low confidence target per vault: $600 * 30% / 5 = **$36** (6%)
- 1 new high-confidence vault: deposits $84 (not $60 as simple 1/10 would give)

**Example 2 (multiple new vaults):**
- Total capital: $10,000, recommendations: 5 high / 5 low
- High target: $10,000 * 70% / 5 = $1,400 each (14%)
- Low target: $10,000 * 30% / 5 = $600 each (6%)
- 2 new high + 1 new low: deposits $1,400 + $1,400 + $600 = $3,400 total
- Vaults with existing exposure: skipped entirely
- Any allocation < $5: skipped and logged

### Key Patterns

- **Services**: Static methods, singletons under `src/service/`
- **Caching**: Multiple TTL configs (vault cache 5min, portfolio 2min, market data 60s)
- **Barbell Strategy**: 70-80% to high-confidence vaults, 20-30% to low-confidence
- **Two-Stage Ranking**: Batches of 10 vaults scored sequentially (with rate limit delays), then top 12 candidates ranked for final allocation. Configurable via `CLAUDE_BATCH_SIZE` (default 10), `CLAUDE_FINAL_RANKING_LIMIT` (default 12), with richer data per vault (`CLAUDE_MAX_TRADES_PER_VAULT=50`, `CLAUDE_MAX_POSITIONS_PER_VAULT=30`, `CLAUDE_MAX_PNL_POINTS=60`)
- **Score-based prioritization**: When more recommendations exist than available slots, vaults are sorted by score (descending) within each confidence group before selection
- **Market data overlay**: Enhanced indicators include BTC/ETH price changes, funding rates, open interest, volume, and long/short ratio for regime detection

## Environment Variables

Required (no defaults):
```
ANTHROPIC_API_KEY=<key>
WALLET=0x<user-address>
WALLET_PK=0x<private-key>
```

Optional (Claude AI):
```
CLAUDE_MODEL=claude-3-haiku-20240307    # Default model for both stages (default: claude-3-haiku-20240307)
CLAUDE_SCORING_MODEL=                   # Model for Stage 1 batch scoring (default: uses CLAUDE_MODEL)
CLAUDE_RANKING_MODEL=                   # Model for Stage 2 final ranking (default: uses CLAUDE_MODEL)
CLAUDE_TEMPERATURE=0.2                  # Temperature for AI responses (default: 0.2)
CLAUDE_SCORING_MAX_TOKENS=4096          # Max tokens for batch scoring (default: 4096)
CLAUDE_RANKING_MAX_TOKENS=4096          # Max tokens for final ranking (default: 4096)
CLAUDE_BATCH_SIZE=10                    # Vaults per scoring batch (default: 10)
CLAUDE_FINAL_RANKING_LIMIT=12           # Max vaults sent to final ranking (default: 12)
CLAUDE_API_DELAY_MS=60000               # Delay between API calls in ms (default: 60s)
CLAUDE_MAX_TRADES_PER_VAULT=50          # Max trades included per vault (default: 50)
CLAUDE_MAX_POSITIONS_PER_VAULT=30       # Max positions included per vault (default: 30)
CLAUDE_MAX_PNL_POINTS=60                # Max PnL data points per vault (default: 60)
```

Optional (vault filtering):
```
VAULT_MIN_TVL=10000                    # Minimum TVL in USD (default: 10,000)
VAULT_MIN_AGE_DAYS=50                  # Minimum vault age in days (default: 21)
VAULT_MIN_FOLLOWERS=10                 # Minimum follower count (default: 10)
VAULT_MIN_TRADES_7D=5                  # Minimum trades in last 7 days (default: 5)
VAULT_REQUIRE_POSITIVE_WEEKLY_PNL=false
VAULT_REQUIRE_POSITIVE_MONTHLY_PNL=false
```

Optional (rebalancing):
```
DEPOSIT_ACTIVE_COUNT=10                # Max active vaults (default: 10)
DEPOSIT_HIGH_PCT=80                    # High-confidence allocation % (default: 80)
DEPOSIT_LOW_PCT=20                     # Low-confidence allocation % (default: 20)
REBALANCE_WITHDRAWAL_DELAY_MS=60000    # Wait time after withdrawals (default: 60s)
```

## Conventions

- TypeScript services under `src/service/`; keep async Hyperliquid calls paced
- Use the `logger` module with context: `logger.info("msg", { context: "data" })`
- Claude payloads include `already_exposed` vaults and expect barbell allocation output
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
- **Vault candidate filtering**: Excludes vaults with 0 active positions to prevent depositing into inactive vaults
- **Inactive vault detection**: Vaults with 0 positions + 0 trades in 7 days trigger immediate withdrawal (even negative PnL)
- **Take-profit strategy**: Over-allocated positions with ROE >= 10% trigger partial withdrawals to target allocation
- **Exit threshold**: Non-recommended vaults only exit when ROE >= 2% (prevents realizing small losses)
- **Error isolation**: Individual deposit failures don't stop subsequent deposits (logged and continued)
- **Vault count enforcement**: System enforces max 10 active vaults; new deposits blocked until count drops below max
- **Dust position filtering**: Positions < $1 USD are excluded when counting active vaults (prevents dust from inflating count)
- **Perps balance**: Uses Hyperliquid `webData2` endpoint to get actual withdrawable balance from clearinghouse state
