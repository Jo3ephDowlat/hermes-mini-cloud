-- Per-user pending clarification state for ambiguous task actions (done/undone/del).
-- Created on branch feature/reminders-voice-v2 (Hermes v1.1 bugfix).
-- Migration 0002 is already applied in production and must never be modified.
-- Migration 0001 is immutable.

CREATE TABLE pending_clarifications (
    telegram_user_id TEXT PRIMARY KEY,
    action           TEXT NOT NULL CHECK (action IN ('done', 'undone', 'del')),
    candidates_json  TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at       TEXT NOT NULL
);

CREATE INDEX idx_pending_clarifications_expires ON pending_clarifications (expires_at);
