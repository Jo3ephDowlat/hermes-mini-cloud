-- hermes-mini-db initial schema
-- Timestamps (created_at, updated_at, completed_at) are UTC.
-- due_date stores a Gregorian ISO date string (YYYY-MM-DD).
-- Calendar-day interpretation for Asia/Tehran is handled in application code.

CREATE TABLE tasks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id TEXT NOT NULL,
    title            TEXT NOT NULL CHECK (length(trim(title)) > 0),
    is_done          INTEGER NOT NULL DEFAULT 0 CHECK (is_done IN (0, 1)),
    due_date         TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at     TEXT
);

CREATE INDEX idx_tasks_user_done_created
    ON tasks (telegram_user_id, is_done, created_at);

CREATE INDEX idx_tasks_user_due_date
    ON tasks (telegram_user_id, due_date);

CREATE TABLE conversation_messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id TEXT NOT NULL,
    role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content          TEXT NOT NULL CHECK (length(trim(content)) > 0),
    created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_conversation_messages_user_id_desc
    ON conversation_messages (telegram_user_id, id DESC);
