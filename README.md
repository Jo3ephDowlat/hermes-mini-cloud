# hermes-mini-cloud

Persian AI Telegram Assistant on Cloudflare Workers — a university Cloud Computing project.

## Project Purpose

hermes-mini-cloud is a minimal serverless application built on [Cloudflare Workers](https://developers.cloudflare.com/workers/).
The long-term goal is a Persian-language AI assistant running as a Telegram bot, entirely on the cloud edge —
with no traditional server to manage. This repository currently contains the **initial project scaffold** only.

## Current Status

- [x] Initial project scaffold (Worker entry point, Wrangler config, TypeScript config)
- [x] Database (D1) — schema migrations defined; remote migration application pending
- [ ] Telegram webhook integration (not yet implemented)
- [ ] LLM integration (not yet implemented)

## Technologies

| Technology | Role |
|---|---|
| Cloudflare Workers | Serverless compute platform (edge runtime) |
| Cloudflare D1 | Serverless SQLite database (binding name: `DB`) |
| Wrangler 4.x | Cloudflare's CLI for migrations & deployment |
| TypeScript | Type-safe JavaScript (strict mode) |
| Node.js / npm | Local tooling and package management |

## HTTP Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Welcome JSON response |
| GET | `/health` | Health check: `{ "ok": true, "service": "hermes-mini-cloud", "status": "running" }` |
| GET | `/health/db` | D1 database health check (runs `SELECT 1 AS ok`); 200 when connected, 503 on failure |
| * | any other path | JSON 404 error |

## Database (Cloudflare D1)

The Worker is bound to a D1 database via the `DB` binding:

| Setting | Value |
|---|---|
| Binding | `DB` |
| Database name | `hermes-mini-db` |
| Config file | `wrangler.jsonc` (`d1_databases`) |
| Migrations directory | `migrations/` |

### Tables

**`tasks`** — todo items per Telegram user.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER | Primary key, autoincrement |
| `telegram_user_id` | TEXT | Not null |
| `title` | TEXT | Not null, must be non-empty |
| `is_done` | INTEGER | Not null, default 0, only 0 or 1 |
| `due_date` | TEXT | Nullable; Gregorian ISO date `YYYY-MM-DD` |
| `created_at` | TEXT | Not null, defaults to UTC timestamp |
| `updated_at` | TEXT | Not null, defaults to UTC timestamp |
| `completed_at` | TEXT | Nullable |

Indexes: `(telegram_user_id, is_done, created_at)` and `(telegram_user_id, due_date)`.

**`conversation_messages`** — chat history per Telegram user.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER | Primary key, autoincrement |
| `telegram_user_id` | TEXT | Not null |
| `role` | TEXT | Not null, only `user` or `assistant` |
| `content` | TEXT | Not null, must be non-empty |
| `created_at` | TEXT | Not null, defaults to UTC timestamp |

Index: `(telegram_user_id, id DESC)`.

### Migration Workflow

SQL migration files live in `migrations/` (e.g. `0001_initial_schema.sql`) and are versioned by filename prefix. Since Wrangler is not run locally (see Development above), migrations are applied remotely against the Cloudflare D1 database:

```bash
npm run db:migrations:list:remote    # list pending/known migrations (remote D1)
npm run db:migrations:apply:remote   # apply unapplied migrations (remote D1)
```

Cloudflare tracks which migrations have already been applied, so `apply` is idempotent.

### Date & Time Conventions

- **Timestamps** (`created_at`, `updated_at`, `completed_at`) are stored as **UTC**.
- **`due_date`** stores a **Gregorian** ISO date string (`YYYY-MM-DD`).
- The app targets users in Iran: a due date's **calendar-day interpretation (Asia/Tehran, UTC+03:30)** is handled in application code, not in SQL. D1 `CURRENT_TIMESTAMP` always yields UTC.

## Development

We develop on Windows 10 using a remote-build workflow — Wrangler is **not** run locally:

1. **Edit locally** — code is written and edited with ZCode and VS Code.
2. **Push to GitHub** — changes are committed and pushed to this repository.
3. **Cloudflare Workers Builds deploys** — Cloudflare connects to the GitHub repo, installs dependencies, and builds/deploys the Worker automatically on every push.

There is no local `npm install` or `npm run dev` step; deployment happens entirely on Cloudflare's side.
