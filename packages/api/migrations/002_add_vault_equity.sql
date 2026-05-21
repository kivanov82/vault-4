-- Vault-only equity (sum across all our vault positions), distinct from HL's
-- portfolio `account_value_usd` which also includes the perps wallet.
-- Needed because cash briefly sitting in perps between a rebalance's withdraws
-- and its redeploys would otherwise look like PnL.

ALTER TABLE portfolio_series
    ADD COLUMN IF NOT EXISTS vault_equity_usd NUMERIC(20, 6);
