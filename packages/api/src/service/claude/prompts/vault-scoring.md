# Stage 1 — Bounded Score Adjustment

For every vault in this batch, submit one bounded qualitative adjustment to its precomputed `quant_score` using the `submit_vault_scores` tool. Do not skip any vault — an entry is required for each.

Each entry has three fields:
- `address` — echo the vault's address exactly as given.
- `adjustment` — points added to `quant_score`, between −15 and +15. 0 = no qualitative evidence beyond the computed score.
- `reason` — one sentence, ≤ 200 chars, required even when `adjustment` is 0; name the concrete field you acted on.

Downstream, the final score is `quant_score + adjustment`, clamped to 0–100. The adjustment is your only lever; the score itself is fixed.

`quant_score` is already comparable across the whole vault universe. This batch is an arbitrary slice for processing — it carries no meaning. Never grade on a curve within the batch, and never let batch position influence an adjustment.

## Default is 0

`quant_score` already prices momentum, consistency, drawdown, exposure, and regime fit. A non-zero adjustment needs qualitative evidence the formulas cannot see. Most vaults in most batches should get 0 — reach for a non-zero number only when a specific input field justifies it.

Sizing: keep routine adjustments in the ±3 to ±8 range; reserve ±10 to ±15 for the strongest, clearest, most decision-changing evidence.

## Legitimate adjustment evidence

Negative:
- `our_vault_history` shows 2+ losing episodes with cumulative negative `realized_pnl_usd` → −5 to −15 by severity.
- `current_positions` `roe_pct <= -10` (deep underwater for us) → negative, unless the vault's own recent tape (`day_rt`, `pnl7_rt`, `winrate_7d`) has clearly turned up.
- Membership in `recently_exited_at_loss` → adjustment must be ≤ 0 unless the setup has materially and demonstrably changed (name what changed).
- Concentration or narrative risk in `top_positions` (e.g. one illiquid alt is most of gross exposure) → small-to-moderate negative.
- `data_quality` flags (thin `trades_7d` / `trades_30d`, missing series) → shrink conviction: small negative, never positive. Thin data is a reason to distrust a high score, never to inflate a low one.

Positive:
- Genuine strength the formula underweights — e.g. consistently profitable on BOTH `pnl7_rt` and `pnl30_rt` with low `pnl_sd_30d`, an `aligned` direction, and a diversified `top_positions` book → modest positive, +3 to +8.

## Never adjust for

- Being already held (`already_exposed` / `currently_held`) — ownership is not edge.
- `tvl` size alone — a big vault is not a good vault.
- Disagreement with the computed score's inputs or their weighting — you do not re-derive the arithmetic.

## Do not double-count regime

`aligned` and `direction` already carry the −0.3 misalignment penalty inside `quant_score`. Do not penalize misalignment again. Only add signal beyond what those fields already capture — for example, `direction` reads `neutral` overall but `top_positions` reveals a crowded one-sided bet the net figure hides.
