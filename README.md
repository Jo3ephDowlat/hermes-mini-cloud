# hermes-mini-cloud

Persian AI Telegram Assistant on Cloudflare Workers — a university Cloud Computing project.

## Project Purpose

hermes-mini-cloud is a minimal serverless application built on [Cloudflare Workers](https://developers.cloudflare.com/workers/).
The long-term goal is a Persian-language AI assistant running as a Telegram bot, entirely on the cloud edge —
with no traditional server to manage. This repository currently contains the **initial project scaffold** only.

## Current Status

- [x] Initial project scaffold (Worker entry point, Wrangler config, TypeScript config)
- [ ] Telegram webhook integration (not yet implemented)
- [ ] Database (D1) (not yet implemented)
- [ ] LLM integration (not yet implemented)

## Technologies

| Technology | Role |
|---|---|
| Cloudflare Workers | Serverless compute platform (edge runtime) |
| Wrangler 4.x | Cloudflare's CLI for local dev & deployment |
| TypeScript | Type-safe JavaScript (strict mode) |
| Node.js / npm | Local tooling and package management |

## HTTP Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Welcome JSON response |
| GET | `/health` | Health check: `{ "ok": true, "service": "hermes-mini-cloud", "status": "running" }` |
| * | any other path | JSON 404 error |

## Development

We develop on Windows 10 using a remote-build workflow — Wrangler is **not** run locally:

1. **Edit locally** — code is written and edited with ZCode and VS Code.
2. **Push to GitHub** — changes are committed and pushed to this repository.
3. **Cloudflare Workers Builds deploys** — Cloudflare connects to the GitHub repo, installs dependencies, and builds/deploys the Worker automatically on every push.

There is no local `npm install` or `npm run dev` step; deployment happens entirely on Cloudflare's side.
