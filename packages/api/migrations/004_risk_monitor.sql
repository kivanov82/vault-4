-- Risk-management overhaul (2026-06): intra-round risk monitor, withdrawal
-- fill verification, exit hysteresis, and per-position trailing stop.
--
-- 1) Extend position_event.action with the new event kinds:
--    - exit_risk_monitor:   intra-round hard stop-loss exit (RiskMonitor)
--    - exit_trailing_stop:  peak-ROE giveback exit (round scan or RiskMonitor)
--    - exit_retry:          re-submitted full exit after fill verification
--                           detected a zero/partial fill
--    - hold_not_recommended: first non-recommended round under hysteresis —
--                           held, exits on the next consecutive one
--
-- 2) position_peak: per-open-position high-water ROE for the trailing stop.
--    Rows are deleted on full exit; the staleness guard in
--    TrailingStopService handles the re-entry-after-missed-delete edge.

DO $$
DECLARE
    cname TEXT;
BEGIN
    SELECT conname INTO cname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'position_event'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%exit_not_recommended%';
    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE position_event DROP CONSTRAINT %I', cname);
    END IF;
END $$;

-- NOT VALID skips the existing-row scan (no ACCESS EXCLUSIVE validation
-- pass), then VALIDATE runs under SHARE UPDATE EXCLUSIVE so concurrent
-- inserts from a still-running old Cloud Run instance aren't blocked.
ALTER TABLE position_event ADD CONSTRAINT position_event_action_check
    CHECK (action IN (
        'deposit',
        'topup',
        'trim',
        'exit_hard_sl',
        'exit_soft_sl',
        'exit_inactive',
        'exit_not_recommended',
        'exit_risk_monitor',
        'exit_trailing_stop',
        'exit_retry',
        'hold_soft_sl',
        'hold_period',
        'hold_not_recommended',
        'skip_recommended'
    )) NOT VALID;

ALTER TABLE position_event VALIDATE CONSTRAINT position_event_action_check;

CREATE TABLE IF NOT EXISTS position_peak (
    vault_address    TEXT PRIMARY KEY,
    peak_roe_pct     NUMERIC(12, 4) NOT NULL,
    peak_equity_usd  NUMERIC(20, 6),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
