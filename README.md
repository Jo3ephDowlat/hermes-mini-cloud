# hermes-mini-cloud

Persian AI Telegram Assistant on Cloudflare Workers — a university Cloud Computing project.

## Project Purpose

hermes-mini-cloud is a serverless Persian-language AI task assistant delivered through a Telegram bot,
running entirely on [Cloudflare Workers](https://developers.cloudflare.com/workers/) with a
[Cloudflare D1](https://developers.cloudflare.com/d1/) database — no traditional server to manage.

## Current Status

- [x] Initial project scaffold (Worker entry point, Wrangler config, TypeScript config)
- [x] Database (D1) — schema and runtime migrations
- [x] Telegram webhook (secret-token verification, allow-list, duplicate protection)
- [x] Task management — add / done / undone / del / list / chat
- [x] LLM intelligence (OpenAI-compatible Chat Completions, strict JSON contract)
- [x] Conversation memory (per-user, persisted in D1)
- [x] Destructive-action confirmation flow (delete-all)
- [ ] Persian UI polish & extra commands (future work)

## Architecture

```
Telegram  ──POST /telegram/webhook──▶  Cloudflare Worker (src/index.ts)
                                          │  1. verify secret token header
                                          │  2. whitelist check (authorized_users)
                                          │  3. claim update_id (dedup in D1)
                                          │  4. check pending confirmation
                                          │  5. load history + task candidates
                                          │  6. call LLM (JSON contract)
                                          │  7. validate → execute in D1
                                          │  8. save messages, reply via Bot API
D1 (hermes-mini-db)  ◀────── DB binding ──┘
OpenAI-compatible API ◀──── LLM_API_URL ─┘
```

Core Worker logic lives in a single file, `src/index.ts`. No frameworks are used — only the
Workers runtime, `fetch`, and D1 prepared statements.

## Technologies

| Technology | Role |
|---|---|
| Cloudflare Workers | Serverless compute platform (edge runtime) |
| Cloudflare D1 | Serverless SQLite database (binding name: `DB`) |
| Wrangler 4.x | Cloudflare's CLI for migrations & deployment |
| TypeScript (strict) | Type-safe JavaScript |
| OpenAI-compatible Chat Completions API | Persian conversational intelligence |

## Environment Variables and Secrets

The five runtime settings are split into two categories:

### Secrets

Set once with `wrangler secret put <NAME>` (or in the Cloudflare dashboard). **None of them are
stored in this repository or in `wrangler.jsonc`.**

| Secret | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token used to send replies via the Telegram Bot API |
| `TELEGRAM_WEBHOOK_SECRET` | Shared secret Telegram echoes in `X-Telegram-Bot-Api-Secret-Token` |
| `LLM_API_KEY` | Bearer key for the LLM provider |

### Plain-text Variables

Stored under `vars` in `wrangler.jsonc` and deployed with the Worker — they are configuration, not
credentials, so they are safe to keep in the repository:

| Variable | Purpose |
|---|---|
| `LLM_API_URL` | **Full** Chat Completions endpoint URL (Cloudflare Workers AI) |
| `LLM_MODEL` | Model name to request from the provider (e.g. `@cf/qwen/qwen3-30b-a3b-fp8`) |

Note: there is no user-ID secret anymore — authorized users are managed in the D1
`authorized_users` whitelist (see below).

## HTTP Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Welcome JSON response |
| GET | `/health` | Service health: `{ "ok": true, "service": "hermes-mini-cloud", "status": "running" }` |
| GET | `/health/db` | D1 health check (`SELECT 1 AS ok`); 200 when connected, 503 on failure |
| POST | `/telegram/webhook` | Telegram updates; 403 without a valid secret header, 200 otherwise |
| * | any other path | JSON 404 error |

## Webhook Security

1. Telegram sends `X-Telegram-Bot-Api-Secret-Token`; it is compared to `TELEGRAM_WEBHOOK_SECRET` using
   a constant-time comparison. Missing or wrong → `403`.
2. Only **private text messages** from users listed in the D1 `authorized_users` whitelist with
   `is_active = 1` are processed; everyone else is silently ignored (HTTP 200, no state change, no
   reply, nothing stored).
3. Idempotency & safe retries: each processable update from an authorized user is claimed in
   `processed_updates` with `INSERT OR IGNORE` — duplicate deliveries return 200 immediately. If
   processing fails **before any user-data mutation** (whitelist query, LLM timeout, transient D1
   error), the claim is released and the Worker answers 500 so Telegram redelivers. Once an action
   has executed, the claim is kept (at-most-once for actions) and post-mutation history writes are
   failure-tolerant, so a retry can never repeat an executed action. As a second layer, **task
   creation is idempotent per update**: every task stores the Telegram `update_id` that created it
   in `tasks.source_update_id` (unique index). If a redelivered update ever reaches `add` again,
   the insert is a no-op (`ON CONFLICT DO NOTHING`) and the user gets a Persian "already processed"
   reply instead of a duplicate task. The duplicate-check lookup is scoped by `telegram_user_id`.
   `done`/`undone`/`del`/`list` are naturally repeatable; the update claim remains the primary
   guard for all actions.
4. Malformed JSON bodies are acknowledged with 200 (stopping retry storms) and discarded.
5. No message contents or secrets are ever logged; only error identities reach `console.error`.
6. All SQL uses D1 prepared statements with bound parameters — user input is never interpolated.
7. The LLM prompt marks user text as data, and every LLM-suggested field is validated before any
   database write; an invalid JSON/action yields a safe Persian fallback with no DB changes.

## Task Actions

| Action | Behavior |
|---|---|
| `add` | Inserts a task with title and optional validated `due_date` (Gregorian `YYYY-MM-DD`) |
| `done` | Marks a task completed; sets `completed_at` and `updated_at` (ownership verified) |
| `undone` | Restores a task; clears `completed_at`, updates `updated_at` (ownership verified) |
| `del` | Deletes one task by verified id; **delete-all** always requires explicit confirmation |
| `list` | Numbers open tasks consistently (1-based, by creation order); completed tasks shown when explicitly requested |
| `chat` | Natural Persian conversational reply |

Task references like "number 3" or "the milk task" are resolved by the LLM against the numbered
candidate list (real task ids) and the conversation history. Ambiguous references set
`needs_clarification` and the bot asks a Persian clarifying question instead of guessing. Every
`task_id` is re-verified against `telegram_user_id` in SQL before any update or delete, so one user
can never affect another user's tasks.

## Conversation Memory

- Both user and assistant messages are stored in `conversation_messages`.
- The latest **12** messages are sent to the LLM with every request, so context persists between requests.
- Stored history is pruned to the most recent **30** messages per user after each reply.

## Destructive-Action Safety (delete-all)

- "Delete all tasks" never executes immediately: it is stored in `pending_confirmations` and the bot
  asks (in Persian) for explicit confirmation.
- Writing «بله» (yes) executes; «انصراف» / «نه» (cancel/no) aborts; any other message implicitly
  cancels the pending operation.
- Pending confirmations expire after **10 minutes** (`expires_at`, checked in SQL) and are purged
  opportunistically.
- Single-task deletion additionally requires a uniquely identified, existing, owned task.

## User Whitelist (`authorized_users`)

The bot is **not public**. Authorization is enforced against the `authorized_users` table in D1
(migration `0002`): a message is processed only when its sender's `telegram_user_id` exists in the
table with `is_active = 1`. Unauthorized users are silently ignored — no reply, no history, no state.

To grant access, run this in the **D1 Console** (Cloudflare dashboard → hermes-mini-db → Console),
replacing `TELEGRAM_ID` with the user's numeric Telegram ID:

```sql
INSERT INTO authorized_users (telegram_user_id, display_name, is_active)
VALUES ('TELEGRAM_ID', 'Professor', 1);
```

To temporarily revoke access (the row and its history remain, but the user can no longer use the bot):

```sql
UPDATE authorized_users SET is_active = 0 WHERE telegram_user_id = 'TELEGRAM_ID';
```

To restore access later, set `is_active = 1` again; to remove a user permanently, `DELETE` the row.
Changes take effect on the user's next message — no redeploy needed.

## Multi-User Data Isolation

Every table is keyed by `telegram_user_id`, and every query that reads or writes user data is scoped
to the caller's ID with a **bound parameter** — never string interpolation:

- **`tasks`** — every `SELECT`/`UPDATE`/`DELETE` filters by `id = ? AND telegram_user_id = ?`; a task
  id belonging to another user matches zero rows, so the action is refused, never applied.
- **`conversation_messages`** — history is loaded, written and pruned per user only.
- **`pending_confirmations`** — keyed by `telegram_user_id` (primary key); delete-all removes only
  `WHERE telegram_user_id = ?`.
- The user ID always comes from the verified Telegram update, never from user-supplied content. The
  LLM may only supply a `task_id`, which is re-verified against the caller's ID in SQL before any
  mutation. Positional references ("شماره ۳") are resolved against the same numbered list the user
  sees (pending 1..n, completed continuing n+1), and the model is forbidden from inventing ids.
  A completed task may be referenced positionally only if a recent assistant message actually
  displayed the numbered completed-task list (detected in conversation history); otherwise the
  model must resolve it by title or ask for clarification.

## Database (Cloudflare D1)

| Setting | Value |
|---|---|
| Binding | `DB` |
| Database name | `hermes-mini-db` |
| Config file | `wrangler.jsonc` (`d1_databases`) |
| Migrations directory | `migrations/` |

### Schema

- **`tasks`** — todo items per Telegram user (`0001_initial_schema.sql`), plus nullable
  `source_update_id` (the Telegram `update_id` that created the task, with a unique index — added
  by migration `0002` so a redelivered update can never create a duplicate task).
- **`conversation_messages`** — chat history per user (`0001`).
- **`authorized_users`** — restricted whitelist of Telegram users (`0002_telegram_runtime.sql`).
- **`processed_updates`** — Telegram `update_id` deduplication (`0002_telegram_runtime.sql`).
- **`pending_confirmations`** — one pending delete-all per user with expiry (`0002`).

### Migration Workflow

Migration files live in `migrations/`, versioned by filename prefix. Wrangler is not run locally
(see Development below); migrations are applied remotely:

```bash
npm run db:migrations:list:remote    # list pending/known migrations (remote D1)
npm run db:migrations:apply:remote   # apply unapplied migrations (remote D1)
```

Cloudflare tracks applied migrations, so `apply` is idempotent. Never modify an already-applied
migration — add a new `000N_*.sql` file instead.

### Date & Time Conventions

- **Timestamps** (`created_at`, `updated_at`, `completed_at`, `processed_at`, …) are stored as **UTC**
  (D1 `CURRENT_TIMESTAMP` / `datetime('now')`).
- **`due_date`** stores a **Gregorian** ISO date string (`YYYY-MM-DD`), validated as a real calendar
  date in application code (not just a matching string).
- The authoritative calendar timezone is **Asia/Tehran**: "today" is computed with `Intl` APIs using
  `timeZone: "Asia/Tehran"`, never the server timezone. Both Gregorian and Jalali (Persian) dates are
  provided to the LLM as context; relative dates like «فردا» are resolved by the model against this
  context and re-validated by the Worker before storage.

## Development

We develop on Windows 10 using a remote-build workflow — Wrangler is **not** run locally:

1. **Edit locally** — code is written and edited with ZCode and VS Code.
2. **Typecheck** — `npm run typecheck` (`tsc --noEmit`).
3. **Push to GitHub** — changes are committed and pushed to this repository.
4. **Cloudflare Workers Builds deploys** — Cloudflare connects to the GitHub repo, installs
   dependencies, and builds/deploys the Worker automatically on every push.

Secrets are set once in the Cloudflare dashboard / via `wrangler secret put` and are read from
`env` at runtime.
