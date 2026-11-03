-- Runtime tables for Telegram webhook processing.
-- Never touches tables created by 0001_initial_schema.sql.

-- Deduplication of Telegram updates. Telegram retries deliveries until a 2xx
-- is returned; a row here guarantees each update_id is processed at most once.
CREATE TABLE processed_updates (
    update_id    INTEGER PRIMARY KEY,
    processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Destructive-action confirmations: at most one pending operation per user,
-- expiring after 10 minutes (enforced in queries via expires_at).
CREATE TABLE pending_confirmations (
    telegram_user_id TEXT PRIMARY KEY,
    action_json      TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at       TEXT NOT NULL
);

CREATE INDEX idx_pending_confirmations_expires ON pending_confirmations (expires_at);
CREATE INDEX idx_processed_updates_processed_at ON processed_updates (processed_at);

-- Restricted whitelist of explicitly authorized Telegram users.
-- Only rows with is_active = 1 may interact with the bot.
CREATE TABLE authorized_users (
    telegram_user_id TEXT PRIMARY KEY,
    display_name     TEXT,
    is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Idempotent task creation: remember which Telegram update created each task.
-- tasks is created by migration 0001 (already applied); this column is added here.
-- The unique index allows any number of NULLs while guaranteeing a given
-- update_id can create at most one task, even across redelivered updates.
ALTER TABLE tasks ADD COLUMN source_update_id INTEGER;
CREATE UNIQUE INDEX idx_tasks_source_update_id ON tasks (source_update_id);
