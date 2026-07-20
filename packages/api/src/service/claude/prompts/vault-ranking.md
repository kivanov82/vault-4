# Stage 2 — Final Ranking & Barbell Allocation

These vaults are the Stage 1 survivors. Produce the final selection with the `submit_vault_ranking` tool:
- `regime` — a `label` ("risk-on" | "neutral" | "risk-off") and a one-sentence `notes`.
- `ranked` — entries `{rank, address, why_now}`, best first, at most `portfolio_shape.max_active` of them. `why_now` is a brief reason (≤ 200 chars).
- `suggested_allocations` — `high_pct`, `low_pct`, and `targets` (each `{rank, vaultAddress, confidence, allocation_pct}`); allocation values sum to 100.

The `ranked` list and the `targets` list describe the same selected set: every vault you rank must appear in `targets`, and nothing else may.

## Extra inputs at this stage

- `vaults` — the same per-vault fields as the shared brief, but `quant_score` now carries the recency-weighted (48h) profile, so it leans harder on `day_rt` / `pnl7_rt` than Stage 1 did.
- `stage1_results` — per vault: `{address, name, quant_score, adjustment, final_score, reason}`. The `adjustment` is already-vetted evidence from Stage 1; do not re-litigate it.
- `portfolio_shape` — `{max_active, high_slots, low_slots}`: how many vaults to select and the size of each confidence bucket. Reference these fields; never hardcode counts.

## Ranking rules

- Start from the scores (`final_score`, then `quant_score`). Reorder only with a stated qualitative reason, and `why_now` must say what that reason is.
- On a near-tie, break it toward the stronger recent tape (`day_rt`, `pnl7_rt`, `winrate_7d`), cleaner `data_quality`, and better current-regime fit.
- **Underwater incumbents.** If `current_positions` shows `roe_pct <= -10` for a vault, include it ONLY if it ranks within the top `high_slots` on pure merit. A losing vault kept "recommended" blocks the system's soft stop-loss — never re-recommend our own underwater bags out of loyalty.
- **Cooldown.** Never rank vaults in `recently_exited_at_loss` (deposits to them are blocked anyway) unless they now sit clearly at the very top on fresh merit.
- **Repeat losers.** 2+ losing episodes in `our_vault_history` demands visibly stronger current evidence before you rank the vault.
- **Rotation.** Rotation cost is enforced deterministically downstream (a fixed score margin an incumbent's challenger must clear). Do not model rotation cost yourself — rank on merit and current-regime fit.

## Barbell allocation

Split the ranked selection into two buckets:

- **High-confidence** = the first `portfolio_shape.high_slots` ranked vaults — regime-aligned, high-edge. Split `high_pct` (70–80) across them, capped at 15 per vault.
- **Low-confidence** = the remaining `portfolio_shape.low_slots` — a counter-regime hedge. Prefer vaults whose `direction` opposes `regime_flags.regime` / `market_data.preferred_direction`, but only with positive edge (`pnl7_rt >= 0` AND `winrate_7d >= 0.5`).
  - Rationale: `preferred_direction` is a 48h call that can flip mid-cycle; a small opposing allocation caps the downside if the regime read is wrong.
  - If no counter-regime vault clears that edge bar, fill with the next-best aligned vaults — a hedge without edge is just drag.
  - Spread `low_pct` (100 − `high_pct`) evenly across this bucket.
- If `regime_flags.regime` is "neutral", skip the counter-regime preference and fill both buckets by score.

Every ranked vault appears in `targets` with `confidence` "high" or "low" matching its bucket, and all `allocation_pct` values sum to 100.

## Regime output

`label` should normally echo `regime_flags.regime`. If the raw `market_data` genuinely contradicts the flags, you may differ — but say why in `notes`.
