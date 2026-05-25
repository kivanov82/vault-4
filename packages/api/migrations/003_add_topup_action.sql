-- Extend position_event.action enum to include 'topup' (the new "upsize
-- under-allocated recommended position" action emitted by the deposit pass
-- when REBALANCE_TOPUP_ENABLED=true). The original CHECK was anonymous,
-- so look it up by table + column rather than guessing the name.

DO $$
DECLARE
    cname TEXT;
BEGIN
    -- Match by a literal that's definitely in the original CHECK list
    -- ('exit_not_recommended'), not by keyword case, since pg_get_constraintdef
    -- doesn't guarantee uppercase IN across versions.
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

ALTER TABLE position_event ADD CONSTRAINT position_event_action_check
    CHECK (action IN (
        'deposit',
        'topup',
        'trim',
        'exit_hard_sl',
        'exit_soft_sl',
        'exit_inactive',
        'exit_not_recommended',
        'hold_soft_sl',
        'hold_period',
        'skip_recommended'
    ));
