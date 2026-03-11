# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Vault-4 is a fully automated, non-custodial trading platform for Hyperliquid vaults. This monorepo contains both the backend API and frontend UI.

## Monorepo Structure

```
vault-4/
  packages/
    api/    ← Backend API (Express/TypeScript) → deployed to Google Cloud Run
    web/    ← Frontend UI (Next.js/React)      → deployed to Vercel
```

Each package has its own `CLAUDE.md` with detailed instructions. See:
- `packages/api/CLAUDE.md` — backend architecture, rebalancing logic, env vars
- `packages/web/CLAUDE.md` — frontend components, design system, conventions

## Commands

```bash
# Backend (API)
npm run dev:api       # Dev server with hot-reload (port 3000, Docker: 8080)
npm run build:api     # Docker build
npm run start:api     # Production run

# Frontend (Web)
npm run dev:web       # Next.js dev server
npm run build:web     # Production build
npm run start:web     # Start production server
```

## Backend API Endpoints

- `GET /health` — Health check
- `GET /api/positions` — User vault positions
- `GET /api/history?page=1&pageSize=15` — Transaction history
- `GET /api/portfolio` — Aggregated portfolio summary
- `GET /api/metrics` — Platform metrics (TVL, 30d PnL %, win rate, 30d max drawdown)

Add `?refresh=true` to bypass cache.

## Environment Variables

**Backend** (`packages/api/.env`):
```
ANTHROPIC_API_KEY=<key>
WALLET=0x<user-address>
WALLET_PK=0x<private-key>
```

**Frontend** (`packages/web/.env.local`):
```
NEXT_PUBLIC_VAULT_API_BASE_URL=http://localhost:3001   # or Cloud Run URL
```

## Deployment

- **API**: Google Cloud Run (Dockerfile in `packages/api/`)
- **Web**: Vercel (Root Directory set to `packages/web`)

## Conventions

- TypeScript throughout
- Backend: Express 5, static service classes, custom logger
- Frontend: Next.js 16, React 19, Tailwind CSS 4, TanStack Query
- Cyberpunk terminal aesthetic (green/cyan/amber/red color semantics)
