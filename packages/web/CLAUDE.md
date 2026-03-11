# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Vault-4 App is the frontend UI for the Vault-4 automated trading platform. It displays portfolio data, vault positions, performance metrics, and transaction history. This is a **UI-only** project - all business logic and trading operations are handled by the backend API.

## Monorepo

This is the **Web** package (`packages/web/`) within the vault-4 monorepo. The backend API lives at `packages/api/`.

## Tech Stack

- **Framework**: Next.js 16 with React 19
- **Styling**: Tailwind CSS 4
- **UI Components**: Radix UI primitives with shadcn/ui patterns
- **Data Fetching**: TanStack React Query
- **Charts**: Recharts
- **Web3**: wagmi + viem (wallet integration)
- **Notifications**: Sonner
- **Package Manager**: pnpm

## Commands

```bash
pnpm dev      # Development server
pnpm build    # Production build
pnpm start    # Start production server
pnpm lint     # ESLint
```

## Architecture

```
app/
  page.tsx                    # Main entry point (renders TerminalPortfolio)
  layout.tsx                  # Root layout with metadata and providers
  providers.tsx               # App-level providers (React Query, wagmi, theme)
  globals.css                 # Primary global styles (Tailwind + theme vars)

components/
  terminal-portfolio.tsx      # Main container — boot sequence, layout, status bar footer
  terminal-header.tsx         # Header with title, uptime, wallet connect
  positions-table.tsx         # Vault positions with inline bars, vault links + history tab
  pnl-chart.tsx              # Hero PnL/account-value chart with live mode
  performance-metrics.tsx     # Key metrics (30D_TVL, 30D_PNL, 30D_MAX_DRAWDOWN, WIN_RATE) with count-up animation + hover glow
  live-data-ticker.tsx       # Real-time $HYPE price/volume/OI/FR ticker (cyan)
  cycling-text-panel.tsx     # Rotating system messages (amber for warnings)
  account-stats.tsx          # Account overview — fetches from /api/positions
  action-buttons.tsx         # Locked action buttons (beta state)
  blinking-label.tsx         # Section label with color/prefix variants
  typing-text.tsx            # Typewriter text effect
  matrix-rain.tsx            # Background matrix rain animation
  corner-decorations.tsx     # Decorative corner elements
  boot-sequence.tsx          # Boot sequence animation component
  status-bar.tsx             # Status bar component
  theme-provider.tsx         # Dark/light theme support

lib/
  utils.ts                   # Utility functions (cn for classnames)
  constants.ts               # App constants and configuration
  wagmi.ts                   # wagmi/Web3 wallet configuration
```

## Backend API Endpoints

The UI consumes these endpoints from the vault-4 backend (default: `http://localhost:3001`):

- `GET /health` - Health check
- `GET /api/positions` - User vault positions
- `GET /api/history?page=1&pageSize=15` - Transaction history
- `GET /api/portfolio` - Aggregated portfolio summary
- `GET /api/metrics` - Platform metrics (TVL, 30d PnL %, win rate, 30d max drawdown)

Add `?refresh=true` to bypass cache.

## Environment Variables

```
NEXT_PUBLIC_VAULT_API_BASE_URL=http://localhost:3001  # Backend API URL (production: Cloud Run URL)
```

## Design System

The UI uses a cyberpunk terminal aesthetic with a structured color/depth system defined in `app/globals.css`:

**Color semantics:**
- **Green** (`--terminal-green`) — primary data, PnL, default text
- **Cyan** (`--terminal-cyan`) — market data, ticker, uptime, account stats, informational
- **Amber** (`--terminal-amber`) — warnings, disclaimers, beta notices
- **Red** (`--terminal-red`) — negative values, errors, destructive

**Depth levels (border classes):**
- `terminal-border` — standard panel
- `terminal-border-inset` — recessed/embedded panels (metric cards)
- `terminal-border-hero` — elevated/prominent panels (chart)
- `terminal-border-cyan` / `terminal-border-amber` — accent-colored panels

**Animations:**
- Boot sequence: sections cascade in with `boot-section boot-delay-N` classes (120ms stagger)
- CRT: subtle flicker + scanline overlay + vignette burn
- `terminal-loader-bar` — animated progress bar for loading states
- `metric-card` — hover glow; `metric-card-negative` — red flash on mount
- `glitch-hover` — glitch effect on hover (used on title)

## Conventions

- Components use TypeScript with strict typing
- Styling follows Tailwind CSS utility-first approach
- Terminal/retro aesthetic with cyan/amber/green color semantics
- Components are functional with React hooks
- State management via React Query for server state
- Section labels use `BlinkingLabel` with varied prefixes (`>`, `$`, `#`, `::`, `//`) and colors per section type

## Deployment

- Hosted on Vercel
- Auto-synced with v0.app deployments
- Live at: https://vercel.com/kivanov82s-projects/v0-vault-4-ui

## Gotchas

- `app/globals.css` is the primary stylesheet; `styles/globals.css` also exists but is secondary
- `next.config.mjs` has `ignoreBuildErrors: true` — TypeScript errors won't block builds
- Backend runs on port 3001 locally (not 3000)
- Action buttons are intentionally locked (beta) — they use `terminal-button-locked` class, not `terminal-button`
- `account-stats.tsx` fetches real data from `/api/positions` — no `isConnected` prop needed

## Notes

- This is a UI-only project - do not add backend logic here
- The project was initially scaffolded with v0.app
- When making changes, ensure compatibility with the backend API contract
