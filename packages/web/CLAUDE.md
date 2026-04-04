# CLAUDE.md — Web Package

This is the **frontend UI** (`packages/web/`) within the vault-4 monorepo. The backend API lives at `packages/api/`.

## Overview

Vault-4 Web displays portfolio data, vault positions, performance metrics, and transaction history. This is a UI-only package — all business logic and trading operations are in the API package.

## Tech Stack

- **Framework**: Next.js 16 with React 19
- **Styling**: Tailwind CSS 4
- **UI Components**: Radix UI primitives with shadcn/ui patterns
- **Data Fetching**: TanStack React Query
- **Charts**: Recharts
- **Web3**: wagmi + viem (wallet integration)
- **Notifications**: Sonner

## Commands

```bash
npx next dev      # Development server
npx next build    # Production build
npx next start    # Start production server
```

## Architecture

```
app/
  page.tsx                    # Main entry point (renders TerminalPortfolio)
  layout.tsx                  # Root layout with metadata and providers
  providers.tsx               # App-level providers (React Query, wagmi, theme)
  globals.css                 # Primary global styles (Tailwind + theme vars)

components/
  terminal-portfolio.tsx      # Main container — layout orchestration
  terminal-header.tsx         # Header with title, uptime, wallet connect
  positions-table.tsx         # Vault positions with inline bars, vault links + history tab
  pnl-chart.tsx              # Hero PnL/account-value chart with [PNL]/[ACC_VALUE] toggle + live mode
  performance-metrics.tsx     # Key metrics with [ANNUALIZED]/[30D_PNL] toggle, count-up animation + hover glow
  live-data-ticker.tsx       # Real-time $HYPE price/volume/OI/FR ticker (cyan)
  cycling-text-panel.tsx     # Rotating system messages (amber for warnings)
  account-stats.tsx          # Account overview — fetches from /api/positions
  action-buttons.tsx         # Locked action buttons (beta state)
  blinking-label.tsx         # Section label with color/prefix variants
  typing-text.tsx            # Typewriter text effect
  matrix-rain.tsx            # Background matrix rain animation
  corner-decorations.tsx     # Decorative corner elements
  theme-provider.tsx         # Dark/light theme support

lib/
  utils.ts                   # Utility functions (cn for classnames)
  constants.ts               # App constants and configuration
  wagmi.ts                   # wagmi/Web3 wallet configuration
```

## Backend API

The UI consumes endpoints from the API package (`packages/api/`):

- `GET /api/positions` — User vault positions
- `GET /api/portfolio` — Aggregated portfolio summary
- `GET /api/metrics` — Platform metrics (TVL, 30d/60d PnL %, win rate, max drawdown)
- `GET /api/history?page=1&pageSize=15` — Transaction history

Append `?refresh=true` to bypass cache.

## Environment Variables

```
NEXT_PUBLIC_VAULT_API_BASE_URL=http://localhost:3000   # Backend API URL
```

Production: set to the Cloud Run URL.

## Design System

Cyberpunk terminal aesthetic defined in `app/globals.css`:

**Color semantics:**
- **Green** (`--terminal-green`) — primary data, PnL, default text
- **Cyan** (`--terminal-cyan`) — market data, ticker, uptime, account stats
- **Amber** (`--terminal-amber`) — warnings, disclaimers, beta notices
- **Red** (`--terminal-red`) — negative values, errors

**Depth levels (border classes):**
- `terminal-border` — standard panel
- `terminal-border-inset` — recessed/embedded panels (metric cards)
- `terminal-border-hero` — elevated/prominent panels (chart)
- `terminal-border-cyan` / `terminal-border-amber` — accent-colored panels

**Animations:**
- CRT: subtle flicker + scanline overlay + vignette burn
- `terminal-loader-bar` — animated progress bar for loading states
- `metric-card` — hover glow; `metric-card-negative` — red flash on mount
- `glitch-hover` — glitch effect on hover (used on title)

## Deployment

Vercel. Set Root Directory to `packages/web`.

## Conventions

- Components use TypeScript with functional components and hooks
- Styling follows Tailwind CSS utility-first approach
- State management via React Query for server state
- Section labels use `BlinkingLabel` with varied prefixes (`>`, `$`, `#`, `::`, `//`) and colors per section type

## Gotchas

- `app/globals.css` is the primary stylesheet; `styles/globals.css` also exists but is secondary
- `next.config.mjs` has `ignoreBuildErrors: true` — TypeScript errors won't block builds
- Action buttons are intentionally locked (beta) — they use `terminal-button-locked` class
- `account-stats.tsx` fetches real data from `/api/positions` — no `isConnected` prop needed
- Annualized performance = compound annualization of 60D PnL (computed client-side from `pnlChange60dPct`)
