# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Vault-4 is a fully automated, non-custodial trading platform for Hyperliquid vaults. This monorepo contains both the backend API and the frontend UI.

## Monorepo Structure

```
vault-4/
  packages/
    api/    <- Backend API (Express/TypeScript) -> Google Cloud Run
    web/    <- Frontend UI (Next.js/React)      -> Vercel
```

Each package has its own `CLAUDE.md` with detailed instructions:
- `packages/api/CLAUDE.md` — backend architecture, rebalancing logic, env vars
- `packages/web/CLAUDE.md` — frontend components, design system, conventions

## Commands

```bash
# Root convenience scripts
npm run dev:api       # Backend dev server (port 3000, Docker: 8080)
npm run dev:web       # Frontend Next.js dev server
npm run build:api     # Docker build for API
npm run build:web     # Next.js production build
npm run start:api     # Start API
npm run start:web     # Start frontend

# Or run directly in each package
cd packages/api && npm run dev
cd packages/web && npx next dev
```

## API Endpoints

- `GET /health` — Health check
- `GET /api/positions` — User vault positions
- `GET /api/history?page=1&pageSize=15` — Transaction history
- `GET /api/portfolio` — Aggregated portfolio summary
- `GET /api/metrics` — Platform metrics (TVL, 30d/60d PnL %, win rate, max drawdown)

Append `?refresh=true` to bypass cache.

## Environment Variables

**Backend** (`packages/api/.env`):
```
ANTHROPIC_API_KEY=<key>
WALLET=0x<user-address>
WALLET_PK=0x<private-key>
```

**Frontend** (`packages/web/.env.local`):
```
NEXT_PUBLIC_VAULT_API_BASE_URL=http://localhost:3000
```

Production frontend points to the Cloud Run URL.

## Deployment

- **API** (`packages/api`): Google Cloud Run — `Dockerfile` in `packages/api/`, exposes port 8080
- **Web** (`packages/web`): Vercel — set Root Directory to `packages/web`

## Conventions

- TypeScript throughout both packages
- Backend: Express 5, static service classes, custom JSON logger
- Frontend: Next.js 16, React 19, Tailwind CSS 4, TanStack Query
- Cyberpunk terminal aesthetic (green/cyan/amber/red color semantics)
- Keep backend and frontend types in sync when modifying API contracts
