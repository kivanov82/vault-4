# AGENTS.md

This file defines local instructions for Codex in this repository.

## Goals
- Discover deposit-open Hyperliquid vaults, rank them (OpenAI + market overlay),
  and run rolling rebalancing on a 2-day cadence.
- Expose API endpoints for platform performance, positions, history, and metrics
  to support the UI dashboard.
- Run automated rebalancing every 2 days: withdraw from non-recommended vaults
  only when PnL is positive, then redeploy available capital across the top set.

## Workflow
- Run locally with `npm run dev`; production start with `npm run start`.
- Tests: `npm run test` (none defined yet).
- Environment: `.env` should include OpenAI credentials, Hyperliquid settings,
  and wallet keys (`OPENAI_API_KEY`, `WALLET`, `WALLET_PK`, etc.).
- Rebalancing is scheduled on startup; it respects the last deposit time and
  waits until 2+ days have passed before running a round.
- Warmup: `VaultService.warm()` runs at startup when
  `VAULT_WARM_RECOMMENDATIONS=true`.

## Conventions
- TypeScript services live under `src/service`; keep async Hyperliquid calls
  paced and log via `logger`.
- Prefer ASCII in files unless the file already uses Unicode.
- OpenAI payloads include `already_exposed` and expect barbell allocation output.

## Notes
- Working directory: `/Users/kirilivanov/DEV/vault-4`.
- Shell: `bash`.
- Rebalancing defaults:
  - Interval: 2 days (`REBALANCE_INTERVAL_MS`).
  - Dry run: enabled unless `REBALANCE_DRY_RUN=false`.
  - Optional withdrawal settle delay via `REBALANCE_WITHDRAWAL_DELAY_MS`.
  - Withdraws only positive-PnL vaults that are no longer recommended.
- OpenAI payload size is capped via:
  `OPENAI_MAX_TRADES_PER_VAULT`, `OPENAI_MAX_POSITIONS_PER_VAULT`,
  `OPENAI_MAX_PNL_POINTS`, and `HYPERLIQUID_DATA_REQUEST_DELAY_MS`.
