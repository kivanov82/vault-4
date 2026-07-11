-- Rotation cost hurdle (2026-07, STRATEGY-FORENSICS-2026-07 §5 — the
-- un-shipped 2026-06 §7.5): a PROFITABLE non-recommended incumbent that has
-- passed the hold period and the hysteresis streak is still only rotated out
-- when the best NEW deposit target out-scores it by ROTATION_SCORE_MARGIN
-- stage-1 points. Claude's ranking is unstable round-to-round; without a
-- margin, ranking noise alone drives >100%-of-book turnover per 10 days
-- (epoch tape: Archangel 9-day round trip for −$0.13, BULBUL2DAO 7-day for
-- −$4.47).
--
-- Extend position_event.action with:
--   - hold_rotation_hurdle: rotation blocked by the score-margin hurdle.
--     Like hold_chop it is deliberately NOT counted by
--     countHoldNotRecommendedStreak and NOT a "was recommended" streak-reset
--     marker — the hysteresis clock freezes while the hurdle holds.

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
-- instance aren't blocked (same pattern as 003/004/005).
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
        'hold_rotation_hurdle',
        'skip_recommended'
    )) NOT VALID;

ALTER TABLE position_event VALIDATE CONSTRAINT position_event_action_check;
