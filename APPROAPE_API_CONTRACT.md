# Approape Integration Contract — Scrrprr Bursa v1 API

- **Provider:** Scrrprr
- **Source Identifier:** `bursa`
- **Schema Version:** `1.0`
- **Base Path:** `/api/v1/bursa`
- **Timestamps:** UTC ISO 8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`)

---

## 1. Purpose & Responsibility Boundary

This API exposes structured public listing observations and append-only field change events collected from Bursa by Scrrprr so Approape (`approape.ro`) can independently evaluate candidate location changes for manual review or downstream workflows.

**Contractual boundaries:**
- Scrrprr does **not** perform cross-platform person matching or assert that a Bursa phone number identifies a specific Approape profile.
- Scrrprr does **not** merge separate Bursa listings that share a phone number; each listing record has its own stable `id` and `source_listing_id`.
- Approape is solely responsible for verification, human review workflows, and any updates inside Approape.

---

## 2. Versioning & Compatibility Policy

1. Every JSON response includes `"source": "bursa"`, `"schema_version": "1.0"`, and `"generated_at"` (UTC ISO 8601).
2. Existing fields, types, and semantic meanings in `v1` are immutable once published.
3. Future additive enhancements will only introduce new optional fields or a new version prefix (`/api/v2/bursa/*`).

---

## 3. Authentication & Privacy Controls

All `/api/v1/bursa/*` endpoints require server-to-server authentication. Never call these endpoints directly from public browser clients or expose the API key.

**Accepted headers:**
- `Authorization: Bearer <BURSA_API_KEY_OR_API_KEY>`
- `X-Api-Key: <BURSA_API_KEY_OR_API_KEY>`

Scrrprr resolves the expected secret from `process.env.BURSA_API_KEY`, falling back to `process.env.API_KEY`, and verifies tokens using constant-time comparison (`crypto.timingSafeEqual`).

**Contact data handling:**
- Publicly displayed phone numbers (`contact.phone` and `contact.normalized_phone`) are strictly restricted behind API key authentication.
- Phone numbers are redacted from application logs and error responses, and are never included in `/api/v1/bursa/health`.
- Retain only information that can lawfully be collected and processed.

---

## 4. Identity, Status Lifecycle & Null Semantics

### 4.1 Listing Identifiers
- `id` (`string`): Stable internal deterministic ID (`"bursa_<20-hex>"`), derived from `source_listing_id` and never based on array indexes.
- `source_listing_id` (`string`): Prioritizes Bursa's actual numeric listing ID when present in upload paths or DOM attributes (e.g., `"54362"`). Falls back to a deterministic URL path hash (`"bp_<16-hex>"`) only when no numeric ID exists, ignoring `07xxxxxxxx` phone segments in URL slugs. If a record originally stored with `"bp_<hash>"` later yields a numeric ID at the exact same canonical `source_url`, `id` and `first_seen_at` remain intact while `source_listing_id` upgrades cleanly.

### 4.2 Status Values (`BursaListingStatus`)
| Status | Meaning |
| --- | --- |
| `"active"` | Observed during the most recent successful discovery or detail check. |
| `"inactive"` | Previously active listing absent from a **complete, successful, non-empty** discovery sweep. Automatically transitions back to `"active"` if observed again later. |
| `"removed"` | Confirmed HTTP `404` / `410` or explicit upstream removal/expiration notice on the listing page. |
| `"unknown"` | Indeterminate observation state. |

**Failure protection guarantee:** Failed, rate-limited, interrupted, CAPTCHA-blocked, or zero-result sweeps (`outcome: "failed"` or `"success_zero_results"`) **never** create, update, reactivate, mark `inactive`, or mark `removed` any listing records or emit change events.

### 4.3 Missing vs. Empty Distinction
- `null`: Element or metadata field was absent or unavailable in the scraped HTML/JSON-LD (e.g., `description: null` on a summary card, or `contact.phone: null` when click-protected).
- `""`: Container/attribute was explicitly present on the page with empty content (e.g., empty `.anunt-desc` container -> `description: ""`).

---

## 5. Endpoints

### 5.1 `GET /api/v1/bursa/listings` (alias: `GET /api/v1/bursa/ads`)

Returns paginated Bursa listings ordered by `last_updated_at DESC, first_seen_at DESC, id ASC`, each embedding its append-only change history (`changes` sorted `detected_at DESC`). Also accessible via `/api/bursa/*` with identical authentication and schema.

#### Query Parameters
| Parameter | Type | Required | Default | Constraints / Description |
| --- | --- | --- | --- | --- |
| `page` | integer | No | `1` | `>= 1` |
| `per_page` | integer | No | `50` | `1` to `100` |
| `updated_since` | ISO 8601 UTC string | No | — | Filters records where `last_updated_at >= updated_since` |
| `status` | enum string | No | — | One of `active`, `inactive`, `removed`, `unknown` |
| `city` | string | No | — | Case- & diacritic-insensitive substring match against `location.city` |
| `county` | string | No | — | Case- & diacritic-insensitive exact match against `location.county` |
| `source_listing_id` | string | No | — | Exact match against `source_listing_id` |

#### Listing Object Schema (`BursaApiListingDTO`)
| Field | Type | Nullable | Description |
| --- | --- | --- | --- |
| `id` | `string` | No | Stable internal record ID (`bursa_<20-hex>`) |
| `source_listing_id` | `string` | No | Stable Bursa listing ID (`"54362"` or fallback `"bp_<16-hex>"`) |
| `source_url` | `string` | No | Canonical listing URL |
| `title` | `string \| null` | Yes | Untruncated listing title |
| `description` | `string \| null` | Yes | Extracted listing description (`null` if missing, `""` if explicitly empty) |
| `location` | `object` | No | Structured location object: `{ city: string \| null, county: string \| null, raw: string \| null }` |
| `contact` | `object` | No | Public contact object: `{ phone: string \| null, normalized_phone: string \| null }` (`normalized_phone` in `07xxxxxxxx` format where applicable) |
| `published_at` | `string \| null` | Yes | Upstream publication timestamp in UTC ISO 8601 |
| `updated_at` | `string \| null` | Yes | Upstream modified timestamp in UTC ISO 8601 |
| `status` | `BursaListingStatus` | No | `"active" \| "inactive" \| "removed" \| "unknown"` |
| `first_seen_at` | `string` | No | Timestamp when Scrrprr first observed this listing (UTC ISO 8601) |
| `last_seen_at` | `string \| null` | Yes | Most recent timestamp when listing was observed alive (`null` only if never seen active) |
| `last_checked_at` | `string` | No | Most recent check timestamp (UTC ISO 8601) |
| `last_updated_at` | `string` | No | Timestamp of most recent observed change or initial creation (UTC ISO 8601) |
| `changes` | `BursaChangeEvent[]` | No | Historical append-only change events for this listing |

#### Pagination Object (`BursaApiPagination`)
```json
{
  "page": 1,
  "per_page": 50,
  "total": 1,
  "total_pages": 1
}
```

#### Example `200 OK` Response
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
      "changes": [
        {
          "id": "chg_01ab23cd45ef67890123",
          "listing_id": "bursa_9a4f38c21d7b41f0c812",
          "source_listing_id": "54362",
          "field": "location",
          "old_value": {
            "city": "Arad",
            "county": "Arad",
            "raw": "Arad"
          },
          "new_value": {
            "city": "Timisoara",
            "county": "Timis",
            "raw": "Timisoara, Timis"
          },
          "detected_at": "2026-11-14T10:00:00.000Z"
        }
      ]
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 50,
    "total": 1,
    "total_pages": 1
  }
}
```

---

### 5.2 `GET /api/v1/bursa/listings/:id`

Fetches a single listing observation by either its internal `id` (`bursa_...`) or its `source_listing_id` (`54362`).

#### Example `200 OK` Response
```json
{
  "source": "bursa",
  "schema_version": "1.0",
  "generated_at": "2026-11-14T10:05:00.000Z",
  "data": {
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
}
```

---

### 5.3 `GET /api/v1/bursa/changes`

Returns paginated append-only historical change events ordered by `detected_at DESC, id DESC`. Ideal for incremental polling by Approape using `updated_since`.

#### Query Parameters
| Parameter | Type | Required | Default | Constraints / Description |
| --- | --- | --- | --- | --- |
| `page` | integer | No | `1` | `>= 1` |
| `per_page` | integer | No | `50` | `1` to `100` |
| `updated_since` (alias `since`) | ISO 8601 UTC string | No | — | Filters events where `detected_at >= updated_since` |
| `field` | enum string | No | — | One of `title`, `description`, `location`, `contact`, `status`, `published_at`, `source_url` |
| `source_listing_id` | string | No | — | Exact match against `source_listing_id` |
| `status` | enum string | No | — | Filters by the parent listing's current status (`active`, `inactive`, `removed`, `unknown`) |
| `city` | string | No | — | Matches parent listing's current city or `old_value.city` / `new_value.city` |
| `county` | string | No | — | Matches parent listing's current county or `old_value.county` / `new_value.county` |

#### Change Event Schema (`BursaChangeEvent`)
| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Unique immutable change ID (`chg_<20-hex>`) |
| `listing_id` | `string` | Stable parent `BursaListingRecord.id` |
| `source_listing_id` | `string` | Stable parent `BursaListingRecord.source_listing_id` |
| `field` | `BursaChangeField` | `"title" \| "description" \| "location" \| "contact" \| "status" \| "published_at" \| "source_url"` |
| `old_value` | `unknown` | Previously observed field value |
| `new_value` | `unknown` | Newly observed field value |
| `detected_at` | `string` | UTC ISO 8601 timestamp when Scrrprr observed the transition |

---

### 5.4 `GET /api/v1/bursa/health`

Reports scraper operational status, scheduling cadence, last run outcome, and aggregate record counts. Contains zero phone numbers, contact data, or credentials.

#### Status Rules
- `"running"`: Discovery sweep currently in progress.
- `"healthy"`: Latest finished sweep completed with `outcome: "success"` (`> 0` discovered listings).
- `"degraded"`: Latest finished sweep had `outcome: "failed"` or `"success_zero_results"`.
- `"idle"`: No sweeps executed yet since initialization.

#### Example `200 OK` Response
```json
{
  "source": "bursa",
  "schema_version": "1.0",
  "generated_at": "2026-11-14T10:10:00.000Z",
  "data": {
    "status": "healthy",
    "scraper_state": "idle",
    "schedule_interval_ms": 604800000,
    "next_scheduled_run_at": "2026-11-21T10:00:00.000Z",
    "last_run_at": "2026-11-14T10:01:12.000Z",
    "last_run_outcome": "success",
    "last_successful_run_at": "2026-11-14T10:01:12.000Z",
    "last_successful_non_empty_run_at": "2026-11-14T10:01:12.000Z",
    "last_error_summary": null,
    "totals": {
      "listings": 248,
      "active": 212,
      "inactive": 31,
      "removed": 5,
      "unknown": 0,
      "changes": 47
    }
  }
}
```

---

## 6. Standardized Error Responses

All `4xx` and `5xx` responses follow the `BursaApiErrorEnvelope` format:

```json
{
  "source": "bursa",
  "schema_version": "1.0",
  "generated_at": "2026-11-14T10:12:00.000Z",
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "Query parameter 'status' must be one of: active, inactive, removed, unknown"
  }
}
```

| HTTP Status | Error Code | When Returned |
| --- | --- | --- |
| `400` | `INVALID_PARAMETER` | Invalid `page`, `per_page`, `updated_since`, `status`, or `field` query parameter |
| `401` | `UNAUTHORIZED` | Missing, malformed, or mismatched `Authorization: Bearer` / `X-Api-Key` token |
| `404` | `NOT_FOUND` | Requested `:id` does not match any `id` or `source_listing_id` |
| `500` | `INTERNAL_ERROR` | Unexpected server error (sanitized; never leaks secrets or phones) |
| `503` | `AUTH_NOT_CONFIGURED` | Server lacks both `BURSA_API_KEY` and `API_KEY` environment configuration |
