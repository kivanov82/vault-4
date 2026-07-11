export type RebalanceRoundRow = {
    id: number;
    started_at: Date;
    completed_at: Date | null;
    status: "running" | "completed" | "aborted" | "failed";
    summary_json: any;
    error_text: string | null;
};

export type MarketSnapshotRow = {
    id: number;
    round_id: number;
    captured_at: Date;
    preferred_direction: "long" | "short" | "neutral" | null;
    btc_24h_pct: string | null;
    btc_7d_pct: string | null;
    eth_24h_pct: string | null;
    eth_7d_pct: string | null;
    funding_btc: string | null;
    funding_eth: string | null;
    oi_btc: string | null;
    oi_eth: string | null;
    long_short_ratio: string | null;
    fear_greed: number | null;
    btc_dominance: string | null;
    trend: string | null;
    raw_json: any;
};

export type ClaudeDecisionRow = {
    id: number;
    round_id: number;
    stage: 1 | 2;
    recorded_at: Date;
    model: string | null;
    regime_label: string | null;
    regime_notes: string | null;
    top10_json: any;
    allocations_json: any;
    raw_response_json: any;
};

export type VaultSnapshotRow = {
    id: number;
    round_id: number;
    vault_address: string;
    vault_name: string | null;
    captured_at: Date;
    tvl_usd: string | null;
    age_days: string | null;
    followers: number | null;
    allow_deposits: boolean | null;
    is_closed: boolean | null;
    trades_last_7d: number | null;
    current_positions_count: number | null;
    open_positions_json: any;
    pnl_24h: string | null;
    pnl_7d: string | null;
    pnl_30d: string | null;
    pnl_alltime: string | null;
    max_drawdown_pct: string | null;
    margin_util_pct: string | null;
    net_direction: "long" | "short" | "neutral" | null;
    assumed_bias: "long" | "short" | "neutral" | null;
    is_aligned: boolean | null;
};

export type PositionLedgerRow = {
    id: number;
    time: Date;
    vault_address: string;
    type: "vaultDeposit" | "vaultWithdraw";
    usdc: string;
    requested_usd: string | null;
    net_withdrawn_usd: string | null;
    basis_usd_hl: string | null;
    commission_usd: string | null;
    closing_cost_usd: string | null;
};

export type PositionAccountRow = {
    vault_address: string;
    first_deposit_at: Date | null;
    last_event_at: Date | null;
    cumulative_deposits_usd: string;
    cumulative_withdraws_net_usd: string;
    our_basis_usd_open: string;
    our_realized_pnl_usd_total: string;
    is_open: boolean;
    deposit_count: number;
    withdraw_count: number;
    recomputed_at: Date;
};

export type PositionEventAction =
    | "deposit"
    | "topup"
    | "trim"
    | "exit_hard_sl"
    | "exit_soft_sl"
    | "exit_inactive"
    | "exit_not_recommended"
    | "exit_risk_monitor"
    | "exit_trailing_stop"
    | "exit_retry"
    | "hold_soft_sl"
    | "hold_period"
    | "hold_not_recommended"
    | "hold_chop"
    | "hold_rotation_hurdle"
    | "skip_recommended";

export type PositionEventInput = {
    roundId: number | null;
    vaultAddress: string;
    vaultSnapshotId: number | null;
    occurredAt?: Date;
    action: PositionEventAction;
    amountUsd: number | null;
    preEquityUsd: number | null;
    targetEquityUsd: number | null;
    confidence: "high" | "low" | null;
    reasonText: string | null;
    txMeta: any;
    succeeded: boolean;
    hlPnlUsd: number | null;
    platformTvlUsd: number | null;
};
