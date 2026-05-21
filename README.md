# Vault-4

Fully automated, non-custodial trading platform for [Hyperliquid](https://hyperliquid.xyz) vaults. Uses Claude AI for vault ranking and automated rebalancing.

## Architecture

```
packages/
  api/    Backend API (Express + TypeScript) -> Google Cloud Run
  web/    Frontend UI (Next.js + React)      -> Vercel
```

**API** discovers and ranks deposit-open vaults using a two-stage Claude AI pipeline, then executes automated 2-day rebalancing cycles with a barbell allocation strategy. Cloud SQL Postgres persists every position lifecycle event, Claude decision, and per-vault snapshot — used to power UI stats from our own FIFO books (not HL's per-withdrawal basis) and to support backtesting.

**Web** displays portfolio data, vault positions, performance metrics, and transaction history in a cyberpunk terminal UI. The PnL chart supports `1min`/`7D`/`30D`/`ALL` periods plus a drag-to-zoom Brush for custom date ranges.

## Quick Start

```bash
# Backend
cd packages/api
cp .env.example .env        # fill in ANTHROPIC_API_KEY, WALLET, WALLET_PK
npm install
npm run dev                  # http://localhost:3000

# Frontend
cd packages/web
cp .env.example .env.local   # set NEXT_PUBLIC_VAULT_API_BASE_URL
npm install
npx next dev                 # http://localhost:3000 (or 3001 if api is running)
```

## Deployment

| Package | Platform | Config |
|---------|----------|--------|
| `packages/api` | Google Cloud Run | Dockerfile in `packages/api/`, port 8080 |
| `packages/web` | Vercel | Root Directory: `packages/web` |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `GET /api/positions` | User vault positions |
| `GET /api/portfolio` | Aggregated portfolio summary (legacy, HL-sourced) |
| `GET /api/portfolio/chart` | PnL + account-value chart from `portfolio_series` (own-books, perps-wallet-clean) |
| `GET /api/metrics` | Platform metrics (TVL, PnL, win rate, drawdown) — sourced from FIFO books |
| `GET /api/history?page=1&pageSize=15` | Transaction history from `position_ledger` |
| `GET /api/trace/rounds?limit=N` | Recent rebalance rounds with summaries |
| `GET /api/trace/rounds/:id` | Round detail: market snapshot, Claude decisions, vault snapshots, position events |
| `GET /api/trace/positions/:vaultAddress` | Per-vault chronological event timeline |

Append `?refresh=true` to bypass cache.

## Persistence (`packages/api/src/db/`)

Cloud SQL Postgres mirrors HL's ledger into `position_ledger` and derives `position_account` via FIFO so cost basis is correct on multi-deposit positions (HL's per-withdrawal `basisUsd` is stored only as `basis_usd_hl` for divergence audit). Every rebalance round writes `rebalance_round` + `market_snapshot` + `claude_decision` + `vault_snapshot[*]` + `position_event[*]` rows. The PnL chart sources from `portfolio_series` (HL `accountValue − perpAccountValue` for vault-only equity).

Schema lives in `packages/api/migrations/`. Migrations run on API startup.

## Social (`packages/api/src/service/social/`)

Daily X (Twitter) posts via `XPostScheduler` — independent of settlement, daily fire with **±10h jitter** (configurable). Content mix covers educational concepts, market reactions, performance highlights (positive only), engine internals, and reactions to crypto news fetched from free RSS feeds (Cointelegraph, Decrypt, The Defiant, DLNews) plus Reddit JSON (`r/Hyperliquid`, `r/CryptoCurrency`, `r/ethfinance`) — keyword-filtered to Hyperliquid / Lighter / perps. The bot persona forbids the word "vault" — speaks as a perps trader running an AI strategy.

## Tech Stack

- **Backend**: Express 5, TypeScript, Hyperliquid SDK, Claude API, node-postgres, twitter-api-v2, node-schedule
- **Frontend**: Next.js 16, React 19, Tailwind CSS 4, TanStack Query, Recharts, wagmi
- **Infra**: Cloud Run (API), Vercel (Web), Cloud SQL Postgres (trace + chart data), Secret Manager (DB credentials)
