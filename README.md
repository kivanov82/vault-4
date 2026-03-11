# Vault-4

Fully automated, non-custodial trading platform for [Hyperliquid](https://hyperliquid.xyz) vaults. Uses Claude AI for vault ranking and automated rebalancing.

## Architecture

```
packages/
  api/    Backend API (Express + TypeScript) -> Google Cloud Run
  web/    Frontend UI (Next.js + React)      -> Vercel
```

**API** discovers and ranks deposit-open vaults using a two-stage Claude AI pipeline, then executes automated 2-day rebalancing cycles with a barbell allocation strategy.

**Web** displays portfolio data, vault positions, performance metrics, and transaction history in a cyberpunk terminal UI.

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
| `GET /api/portfolio` | Aggregated portfolio summary |
| `GET /api/metrics` | Platform metrics (TVL, PnL, win rate, drawdown) |
| `GET /api/history?page=1&pageSize=15` | Transaction history |

Append `?refresh=true` to bypass cache.

## Tech Stack

- **Backend**: Express 5, TypeScript, Hyperliquid SDK, Claude API, node-schedule
- **Frontend**: Next.js 16, React 19, Tailwind CSS 4, TanStack Query, Recharts, wagmi
