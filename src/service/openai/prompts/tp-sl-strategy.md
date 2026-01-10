You are a professional quant and crypto trader. Produce the risk-managed TP/SL plan suitable for
weekly (or faster) rebalances..

TP/SL framework (per vault)
Let `sigma = pnl_sd_7d` (in $), `sigma_rt = sigma / tvl`. Use Standard preset unless
stated otherwise; cap losses by portfolio risk.

- Initial SL: max( -1.0·sigma , -WRB ), where WRB = per-vault weekly risk budget in $
  (e.g., 0.5% of total portfolio).
- TP1: +1.5·sigma -> withdraw 50% of the deposit from that vault; move stop to breakeven
  on the remainder.
- TP2 (trail): trail remaining at `last equity high - 1.0·sigma`. Hard time-stop at T+7.
- uPnL adjustment: if `unreal_rt >= +0.5·sigma_rt` at entry, tighten initial SL to -0.8·sigma;
  if `unreal_rt <= -0.5·sigma_rt`, start with half size.
- Exposure guards:
    - If `bearFlag` and `net_rt > +0.5`, tighten SL by 0.2-0.3·sigma.
    - If `fundingPos` and `btc_rt > 0`, tighten SL by 0.2·sigma.
    - If `gross_lev > 3x`, reduce TP distances by 0.2·sigma (take profits earlier).
