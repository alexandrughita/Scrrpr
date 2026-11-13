# Scrrprr

Scrrprr is a Node.js / TypeScript web scraping, observation archive, and API service with a React + Vite management UI and a versioned `/api/v1/bursa` server-to-server API for external consumption by Approape (`approape.ro`).

---

## Architecture Overview

- **`server.ts`** — Unified Express backend serving legacy crawler routes (`/api/crawler/*`, `/api/locations`, `/api/check-location-change`), the React Vite frontend, and the versioned `/api/v1/bursa/*` router.
- **`src/bursa/`** — Modular v1 Bursa pipeline:
  - `types.ts` — Versioned DTOs, change event schemas, run telemetry, and health snapshot types (`schema_version: "1.0"`).
  - `parser.ts` — Cheerio & JSON-LD extractor prioritizing Bursa's stable numeric listing IDs (with canonical URL-path hash fallback), diacritic-normalized Romanian city/county resolution, `null` vs `""` preservation, UTC ISO 8601 date parsing, `robots.txt` rule parser, CAPTCHA/rate-limit detection, and PII/secret log sanitizer.
  - `store.ts` — Durable JSON persistence under `data/` using atomic temp-file renames, field-level change detection, append-only change history, failure-safe status lifecycle transitions, and paginated/filtered query APIs. Records are keyed strictly by `id` / `source_listing_id` / exact canonical `source_url` and are **never merged by phone number**.
  - `scraper.ts` — Transport-injectable scraper service supporting multi-page pagination, within-sweep deduplication, `robots.txt` enforcement, exponential backoff retries on transient failures (aborting cleanly on CAPTCHAs/403/429 without bypassing controls), concurrency lock to prevent overlapping jobs, zero-result sweep protection, and a configurable weekly scheduler.
  - `router.ts` — Authenticated Express router exposing `/api/v1/bursa/listings`, `/api/v1/bursa/listings/:id`, `/api/v1/bursa/changes`, and `/api/v1/bursa/health`.

---

## Installation & Configuration

### Prerequisites
- Node.js `>= 20` (verified on Node `v22`)
- npm

### Install Dependencies
```bash
npm install
```

### Environment Variables

Configure these in `.env` (see `.env.example` for template; never commit secrets):

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP server listen port |
| `API_KEY` | `""` | Shared Bearer / X-Api-Key secret for server-to-server endpoints |
| `BURSA_API_KEY` | falls back to `API_KEY` | Dedicated API key for `/api/v1/bursa/*` |
| `BURSA_BASE_URL` | `https://bursaplacerilor.com` | Base upstream URL for Bursa discovery |
| `BURSA_SCRAPE_INTERVAL_MS` | `604800000` (7 days) | Automated discovery sweep interval in milliseconds |
| `BURSA_SCHEDULER_ENABLED` | `true` | Set to `false` to disable automatic scheduled runs |
| `BURSA_RUN_ON_STARTUP` | `false` | Set to `true` to trigger a sweep immediately on server start even if prior runs exist |
| `BURSA_MAX_PAGES` | `25` | Maximum pagination pages scanned per discovery sweep |
| `BURSA_REQUEST_DELAY_MS` | `500` | Polite delay between sequential page requests (ms) |
| `GEMINI_API_KEY` | — | Used by existing `/api/content-analysis` feature |
| `NIMFOMANE_USER` / `NIMFOMANE_PASS` | — | Optional credentials for existing forum search tab |

---

## Persistence Structure (`data/`)

The Bursa v1 store persists three atomically updated JSON files inside `data/`:

1. **`data/bursa_v1_listings.json`** — Current observed state for each unique Bursa listing (`id`, `source_listing_id`, `source_url`, `title`, `description`, `location`, `contact`, `published_at`, `updated_at`, `status`, `first_seen_at`, `last_seen_at`, `last_checked_at`, `last_updated_at`).
2. **`data/bursa_v1_changes.json`** — Immutable, append-only log of observed transitions (`id`, `listing_id`, `source_listing_id`, `field`, `old_value`, `new_value`, `detected_at`). Historical records are never overwritten.
3. **`data/bursa_v1_runs.json`** — Audit log of recent discovery runs (last 200 runs) with outcome (`success`, `success_zero_results`, `failed`), counts, and sanitized error summaries.

### Status Transition Safety Rules
- **Absent after 1 complete, successful, non-empty sweep:** `active` -> `inactive` (preserving `last_seen_at`).
- **Explicit HTTP `404`/`410` or confirmed upstream removal notice:** transitions to `removed`.
- **Failed, rate-limited, interrupted, or partial sweep:** preserves all existing listing statuses.
- **Successful sweep returning 0 listings:** recorded as `success_zero_results` and flagged for investigation; preserves all existing listing statuses.

---

## Scraping Schedule

By default (`BURSA_SCHEDULER_ENABLED !== "false"`), `BursaScraperService` schedules an automated weekly discovery sweep every `604800000` ms (7 days), configurable via `BURSA_SCRAPE_INTERVAL_MS`. If no prior `v1` run exists on startup, an initial non-blocking sweep runs automatically. Concurrency locking prevents overlapping runs from spawning duplicate jobs.

---

## API Documentation & Authentication

Full integration contract specifications are documented in [`APPROAPE_API_CONTRACT.md`](./APPROAPE_API_CONTRACT.md).

### Authentication
All `/api/v1/bursa/*` routes require one of:
- `Authorization: Bearer <BURSA_API_KEY_OR_API_KEY>`
- `X-Api-Key: <BURSA_API_KEY_OR_API_KEY>`

Unauthenticated or mismatched requests receive `401 UNAUTHORIZED` (`503 AUTH_NOT_CONFIGURED` if no key is configured).

### Endpoints
- `GET /api/v1/bursa/listings` — Paginated listings with embedded change history. Supports `page`, `per_page` (1–100), `updated_since`, `status`, `city`, `county`, `source_listing_id`.
- `GET /api/v1/bursa/listings/:id` — Single listing lookup by internal `id` or `source_listing_id`.
- `GET /api/v1/bursa/changes` — Paginated append-only change feed. Supports `page`, `per_page`, `updated_since`, `field`, `status`, `city`, `county`, `source_listing_id`.
- `GET /api/v1/bursa/health` — Scraper operational status, schedule timestamps, last run outcome, and aggregate counts (never exposes phone numbers or credentials).

### Example Request & Response

```bash
curl -sS \
  -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3000/api/v1/bursa/listings?county=Timis&status=active&page=1&per_page=10"
```

```json
{
  "source": "bursa",
  "schema_version": "1.0",
  "generated_at": "2026-11-14T10:00:00.000Z",
  "data": [
    {
      "id": "bursa_9a4f38c21d7b41f0c812",
      "source_listing_id": "54362",
      "source_url": "https://bursaplacerilor.com/timis/elena-vip/",
      "title": "Elena VIP | Masaj & Relaxare",
      "description": "Ofer masaj profesionist si companie placuta in Timisoara, zona centrala.",
      "location": {
        "city": "Timisoara",
        "county": "Timis",
        "raw": "Timisoara, Timis"
      },
      "contact": {
        "phone": "0723 111 222",
        "normalized_phone": "0723111222"
      },
      "published_at": "2026-11-01T09:15:00.000Z",
      "updated_at": "2026-11-14T09:45:00.000Z",
      "status": "active",
      "first_seen_at": "2026-11-01T10:00:00.000Z",
      "last_seen_at": "2026-11-14T10:00:00.000Z",
      "last_checked_at": "2026-11-14T10:00:00.000Z",
      "last_updated_at": "2026-11-14T10:00:00.000Z",
      "changes": []
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 10,
    "total": 1,
    "total_pages": 1
  }
}
```

---

## Running Automated Tests

All tests use deterministic HTML fixtures and mocked HTTP transports (no dependency on live external availability):

```bash
npm test
```

Typecheck:

```bash
npm run lint
```

---

## Deployment Instructions

1. Set production environment variables (`PORT=3000`, `NODE_ENV=production`, strong random `API_KEY` / `BURSA_API_KEY`, persistent volume mounted at `/app/applet/data` or working `data/` directory).
2. Install dependencies and build frontend + server bundle:
   ```bash
   npm ci
   npm run build
   ```
3. Start the production server:
   ```bash
   npm start
   ```
4. Verify deployment health with an authenticated request:
   ```bash
   curl -H "Authorization: Bearer $BURSA_API_KEY" http://localhost:3000/api/v1/bursa/health
   ```
