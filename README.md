# node-yt-downloader

Telegram bot for supported media URLs, with PostgreSQL-backed download jobs, retries, Docker deployment, and Prometheus metrics.

## Run locally

1. Copy `.env.example` to `.env` and set `TELEGRAM_BOT_TOKEN`.
2. Install dependencies and run:

```sh
npm ci
npm start
```

When running Node directly, point `DATABASE_URL` at a PostgreSQL server reachable from your host. For the app and PostgreSQL together in Docker (using the Compose hostname in the example URL), run:

```sh
docker compose up --build
```

Docker Compose starts PostgreSQL and the app waits for its health check. On startup, the app creates the `download_jobs` table and indexes automatically. Jobs, retry state, and completed/failed status persist in PostgreSQL across app restarts. Transient failures are retried; unsupported, unavailable, or oversized media failures are marked failed immediately.

Set `DATABASE_URL` in `.env` to one PostgreSQL connection URL. The Compose example is `postgres://yt_downloader:yt_downloader@postgres:5432/yt_downloader`. Keep the hostname `postgres` when connecting from the app container. The database volume is named `postgres-data`. If the app process stops while a job is active, it becomes eligible for retry when its worker lease expires (within two minutes).

## Deployment and operations

- Docker runs as the non-root `node` user.
- Docker health check calls `/ready`.
- `GET /health` is the liveness endpoint.
- `GET /ready` checks bot startup and queue availability.
- `GET /metrics` exports Prometheus metrics, including Node.js process metrics, queue state counts, job totals, retries, active jobs, and job duration.
- Enable the optional Prometheus service with `docker compose --profile monitoring up --build`. It scrapes the app at `app:3000`.
- `SIGINT` and `SIGTERM` initiate graceful shutdown.

## Configuration

| Variable | Required | Default | Description |
|---|---:|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Telegram bot token |
| `DATABASE_URL` | Yes | `postgres://yt_downloader:yt_downloader@postgres:5432/yt_downloader` in Compose | PostgreSQL connection URL for persistent jobs |
| `PORT` | No | `3000` | Health and metrics HTTP port |
| `DOWNLOAD_DIRECTORY` | No | `./downloads` | Writable directory for temporary media files; created when missing |
| `YT_DLP_PATH` | No | Bundled yt-dlp | Optional path to a yt-dlp executable; set it to an installation with `curl_cffi` support for TikTok impersonation |
| `SESSION_STORE_FILE` | No | `./data/sessions.json` | Session cache persistence |
| `SESSION_TTL_MS` | No | `1800000` | Session lifetime |
| `MAX_CONCURRENT_DOWNLOADS` | No | `2` | Worker concurrency |
| `JOB_MAX_ATTEMPTS` | No | `3` | Total attempts per job |
| `JOB_RETRY_DELAY_MS` | No | `5000` | Initial retry delay |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Per-chat rate-limit window |
| `RATE_LIMIT_MAX_REQUESTS` | No | `10` | Per-chat request limit per window |
| `LOG_LEVEL` | No | `info` | `error`, `warn`, `info`, or `debug` |

## Project structure

- `app.js` — application composition, startup, and shutdown
- `src/config/` — validated runtime configuration
- `src/lib/` — queue, rate limiting, and logging
- `src/services/` — Telegram handlers and media operations
- `src/storage/` — session persistence
- `src/telemetry/` — health endpoints and Prometheus registry
- `tests/` — downloader, bot-flow, and queue validation tests
- `deploy/prometheus.yml` — Prometheus scrape configuration
- `Dockerfile` / `docker-compose.yml` — container runtime and dependencies
- `.github/workflows/ci.yml` — Node test matrix and Docker build validation

## CI

GitHub Actions runs tests on Node.js 20 and 22 against PostgreSQL and builds the production Docker image for pushes and pull requests.

Run tests locally with:

```sh
npm test
```

## Operational limitations

- Sessions remain file-based and rate-limit counters remain in memory; share those stores if running multiple app instances. PostgreSQL queue workers use row locks and expiring worker leases so multiple instances can safely claim jobs.
- Telegram profile details are upserted into the PostgreSQL `users` table on bot interactions, and new download jobs reference their user by Telegram ID.
- The Compose PostgreSQL username/password are development defaults. Change them and update `DATABASE_URL` together before deploying beyond a trusted local environment.
- Prometheus metrics and the operational endpoints should be restricted to a trusted network in public deployments.
- TikTok video posts can offer MP4 and MP3 downloads; TikTok photo posts are not supported.
- The Docker image installs yt-dlp with `curl_cffi` support for TikTok's impersonation requirements. For local installs, install `yt-dlp[default,curl-cffi]` in a Python environment and set `YT_DLP_PATH` to its executable if TikTok extraction reports that no impersonation target is available. TikTok can still reject requests independently of this dependency.
- Review the applicable platform terms, copyright rules, and local laws for media downloading.
