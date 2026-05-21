-- Internal trace + persistence layer for vault-4.
-- See /Users/kirilivanov/.claude/plans/jiggly-stargazing-torvalds.md for design.

CREATE TABLE IF NOT EXISTS _migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rebalance_round (
    id            BIGSERIAL PRIMARY KEY,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at  TIMESTAMPTZ,
    status        TEXT NOT NULL CHECK (status IN ('running', 'completed', 'aborted', 'failed')),
    summary_json  JSONB,
    error_text    TEXT
);
CREATE INDEX IF NOT EXISTS rebalance_round_started_at_idx ON rebalance_round (started_at DESC);

CREATE TABLE IF NOT EXISTS market_snapshot (
    id                   BIGSERIAL PRIMARY KEY,
    round_id             BIGINT NOT NULL REFERENCES rebalance_round(id) ON DELETE CASCADE,
    captured_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    preferred_direction  TEXT CHECK (preferred_direction IN ('long', 'short', 'neutral')),
    btc_24h_pct          NUMERIC(12, 4),
    btc_7d_pct           NUMERIC(12, 4),
    eth_24h_pct          NUMERIC(12, 4),
    eth_7d_pct           NUMERIC(12, 4),
    funding_btc          NUMERIC(12, 6),
    funding_eth          NUMERIC(12, 6),
    oi_btc               NUMERIC(20, 2),
    oi_eth               NUMERIC(20, 2),
    long_short_ratio     NUMERIC(10, 4),
    fear_greed           INTEGER,
    btc_dominance        NUMERIC(8, 4),
    trend                TEXT,
    raw_json             JSONB
);
CREATE INDEX IF NOT EXISTS market_snapshot_round_idx ON market_snapshot (round_id);

CREATE TABLE IF NOT EXISTS claude_decision (
    id                  BIGSERIAL PRIMARY KEY,
    round_id            BIGINT NOT NULL REFERENCES rebalance_round(id) ON DELETE CASCADE,
    stage               SMALLINT NOT NULL CHECK (stage IN (1, 2)),
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    model               TEXT,
    regime_label        TEXT,
    regime_notes        TEXT,
    top10_json          JSONB,
    allocations_json    JSONB,
    raw_response_json   JSONB
);
CREATE INDEX IF NOT EXISTS claude_decision_round_idx ON claude_decision (round_id, stage);

CREATE TABLE IF NOT EXISTS vault_snapshot (
    id                       BIGSERIAL PRIMARY KEY,
    round_id                 BIGINT NOT NULL REFERENCES rebalance_round(id) ON DELETE CASCADE,
    vault_address            TEXT NOT NULL,
    vault_name               TEXT,
    captured_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    tvl_usd                  NUMERIC(20, 6),
    age_days                 NUMERIC(10, 2),
    followers                INTEGER,
    allow_deposits           BOOLEAN,
    is_closed                BOOLEAN,
    trades_last_7d           INTEGER,
    current_positions_count  INTEGER,
    open_positions_json      JSONB,
    pnl_24h                  NUMERIC(20, 6),
    pnl_7d                   NUMERIC(20, 6),
    pnl_30d                  NUMERIC(20, 6),
    pnl_alltime              NUMERIC(20, 6),
    max_drawdown_pct         NUMERIC(10, 4),
    margin_util_pct          NUMERIC(10, 4),
    net_direction            TEXT CHECK (net_direction IN ('long', 'short', 'neutral')),
    assumed_bias             TEXT CHECK (assumed_bias IN ('long', 'short', 'neutral')),
    is_aligned               BOOLEAN
);
CREATE INDEX IF NOT EXISTS vault_snapshot_round_vault_idx ON vault_snapshot (round_id, vault_address);
CREATE INDEX IF NOT EXISTS vault_snapshot_vault_time_idx ON vault_snapshot (vault_address, captured_at DESC);

CREATE TABLE IF NOT EXISTS position_ledger (
    id                  BIGSERIAL PRIMARY KEY,
    time                TIMESTAMPTZ NOT NULL,
    vault_address       TEXT NOT NULL,
    type                TEXT NOT NULL CHECK (type IN ('vaultDeposit', 'vaultWithdraw')),
    usdc                NUMERIC(20, 6) NOT NULL,
    requested_usd       NUMERIC(20, 6),
    net_withdrawn_usd   NUMERIC(20, 6),
    basis_usd_hl        NUMERIC(20, 6),
    commission_usd      NUMERIC(20, 6),
    closing_cost_usd    NUMERIC(20, 6),
    CONSTRAINT position_ledger_unique UNIQUE (time, vault_address, type, usdc)
);
CREATE INDEX IF NOT EXISTS position_ledger_time_idx ON position_ledger (time DESC);
CREATE INDEX IF NOT EXISTS position_ledger_vault_time_idx ON position_ledger (vault_address, time);

CREATE TABLE IF NOT EXISTS position_account (
    vault_address                 TEXT PRIMARY KEY,
    first_deposit_at              TIMESTAMPTZ,
    last_event_at                 TIMESTAMPTZ,
    cumulative_deposits_usd       NUMERIC(20, 6) NOT NULL DEFAULT 0,
    cumulative_withdraws_net_usd  NUMERIC(20, 6) NOT NULL DEFAULT 0,
    our_basis_usd_open            NUMERIC(20, 6) NOT NULL DEFAULT 0,
    our_realized_pnl_usd_total    NUMERIC(20, 6) NOT NULL DEFAULT 0,
    is_open                       BOOLEAN NOT NULL DEFAULT FALSE,
    deposit_count                 INTEGER NOT NULL DEFAULT 0,
    withdraw_count                INTEGER NOT NULL DEFAULT 0,
    recomputed_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS position_event (
    id                          BIGSERIAL PRIMARY KEY,
    round_id                    BIGINT REFERENCES rebalance_round(id) ON DELETE SET NULL,
    vault_address               TEXT NOT NULL,
    vault_snapshot_id           BIGINT REFERENCES vault_snapshot(id) ON DELETE SET NULL,
    occurred_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    action                      TEXT NOT NULL CHECK (action IN (
        'deposit',
        'trim',
        'exit_hard_sl',
        'exit_soft_sl',
        'exit_inactive',
        'exit_not_recommended',
        'hold_soft_sl',
        'hold_period',
        'skip_recommended'
    )),
    amount_usd                  NUMERIC(20, 6),
    pre_equity_usd              NUMERIC(20, 6),
    target_equity_usd           NUMERIC(20, 6),
    confidence                  TEXT CHECK (confidence IN ('high', 'low')),
    reason_text                 TEXT,
    tx_meta_json                JSONB,
    succeeded                   BOOLEAN NOT NULL DEFAULT TRUE,
    -- our-own derived state
    our_basis_usd_before        NUMERIC(20, 6),
    our_basis_usd_after         NUMERIC(20, 6),
    our_realized_pnl_usd        NUMERIC(20, 6),
    our_unrealized_pnl_usd      NUMERIC(20, 6),
    our_roe_pct_at_decision     NUMERIC(12, 4),
    platform_tvl_usd_at_event   NUMERIC(20, 6),
    hl_pnl_usd_at_decision      NUMERIC(20, 6)
);
CREATE INDEX IF NOT EXISTS position_event_vault_time_idx ON position_event (vault_address, occurred_at DESC);
CREATE INDEX IF NOT EXISTS position_event_round_idx ON position_event (round_id);
CREATE INDEX IF NOT EXISTS position_event_action_time_idx ON position_event (action, occurred_at DESC);

CREATE TABLE IF NOT EXISTS portfolio_series (
    ts                       TIMESTAMPTZ PRIMARY KEY,
    cumulative_pnl_usd       NUMERIC(20, 6),
    account_value_usd        NUMERIC(20, 6),
    our_realized_pnl_usd     NUMERIC(20, 6),
    our_basis_usd_open       NUMERIC(20, 6)
);
