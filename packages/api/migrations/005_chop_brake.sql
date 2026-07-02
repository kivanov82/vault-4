-- Chop brake (2026-07): when the market-direction signal is neutral or just
-- flipped vs the previous completed round, the rebalance round scales new
-- deposits down and defers non-risk rotation of profitable positions.
--
-- Extend position_event.action with:
--   - hold_chop: rotation deferred by the chop brake. Deliberately NOT
--     counted by countHoldNotRecommendedStreak (which filters on
--     'hold_not_recommended') and NOT a "was recommended" streak-reset
--     marker — the hysteresis clock freezes during chop instead of ticking
--     or restarting.

DO $$
DECLARE
    cname TEXT;
BEGIN
    SELECT conname INTO cname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'position_event'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%exit_risk_monitor%';
    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE position_event DROP CONSTRAINT %I', cname);
    END IF;
END $$;

-- NOT VALID skips the existing-row scan, then VALIDATE runs under SHARE
-- UPDATE EXCLUSIVE so concurrent inserts from a still-running old Cloud Run
-- instance aren't blocked (same pattern as 003/004).
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
        'hold_chop',
        'skip_recommended'
    )) NOT VALID;

ALTER TABLE position_event VALIDATE CONSTRAINT position_event_action_check;
