-- Persistent natural-language reminders (Hermes v2, phase 1).
-- Created on branch feature/reminders-voice-v2.
-- Migrations 0001-0003 are immutable.

-- All timestamps are UTC Unix seconds.
-- status lifecycle:
--   pending  -> claimed -> sent        (normal delivery)
--   pending  -> cancelled              (owner no longer authorized; never sent)
--   claimed  -> pending                (delivery failed: bounded retry via next_attempt_at)
--   pending  -> failed                 (5 failed delivery attempts; never retried)
--   claimed  -> pending                (stale claim recovered after 16 minutes)
CREATE TABLE reminders (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id TEXT NOT NULL,
    message          TEXT NOT NULL CHECK (length(trim(message)) > 0),
    due_at           INTEGER NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'sent', 'cancelled', 'failed')),
    created_at       INTEGER NOT NULL,
    claimed_at       INTEGER,
    sent_at          INTEGER,
    attempt_count    INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  INTEGER
);

-- Delivery scan: due pending reminders, oldest first.
CREATE INDEX idx_reminders_due_status ON reminders (status, due_at);
-- Per-user reminder history.
CREATE INDEX idx_reminders_user ON reminders (telegram_user_id, created_at);
