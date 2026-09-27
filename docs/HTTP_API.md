# HTTP API

The original health/geocoder routes are described below. The explicit actions
are documented in [Enrichment services](ENRICHMENT_SERVICES.md); scheduled
enrichment and WebP routes are in [Scheduled enrichment](CRON_MIGRATION.md). Everything is wired up in
[`src/routes/index.mjs`](../src/routes/index.mjs) and
[`src/routes/cron.routes.mjs`](../src/routes/cron.routes.mjs).

Base URL in production: `https://wareongo-cronjobs.duckdns.org` (Caddy fronts
the Node app on port 3000 — see [deploy/AWS_DEPLOYMENT.md](../deploy/AWS_DEPLOYMENT.md)).

Local: `http://localhost:3000`.

---

## `GET /health`

Liveness + DB connectivity check. No auth.

### 200 OK

```json
{ "status": "ok", "db": "connected" }
```

### 503 Service Unavailable

```json
{ "status": "error", "db": "<error message from Prisma>" }
```

Caddy and the systemd unit don't currently use this for active health
probing, but it's wired for that purpose if you ever add an ALB or external
monitor.

---

## `POST /cron/geocode-recent`

Triggers one pass of the geocoder over warehouses created or updated in the
last 7 days that still lack lat/lng. Synchronous: the request blocks until
the run finishes (typically tens of seconds to a few minutes).

Called by Supabase `pg_cron` once a day at 21:27 UTC (≈ 02:57 IST). The
SQL that wires this up lives in [`sql/pg_cron_setup.sql`](../sql/pg_cron_setup.sql)
(gitignored).

### Auth

Header: `Authorization: Bearer <CRON_SECRET>`.

The server reads `CRON_SECRET` from env at boot
([`src/middlewares/requireCronAuth.mjs`](../src/middlewares/requireCronAuth.mjs)).
Constant-time comparison is **not** used today — adequate for an internal
endpoint reachable only via Supabase's known egress, but worth tightening if
the threat model widens.

### Request body

Ignored. Send `{}` or nothing.

### 200 OK

```json
{
  "runId": 42,
  "jobName": "geocode-recent",
  "scope": "recent-7d",
  "candidates": 17,
  "processed": 17,
  "succeeded": 14,
  "failed": 3,
  "durationMs": 38421
}
```

| Field | Meaning |
|---|---|
| `runId` | Auto-increment id of the `CronRunLog` row written for this invocation. |
| `scope` | Always `"recent-7d"` — kept as a field so future variants (e.g. `all`) can be distinguished. |
| `candidates` | Number of pending warehouses found by the SQL query in [`src/models/geocode/attemptRepo.mjs`](../src/models/geocode/attemptRepo.mjs). |
| `processed` | Of those, how many were attempted (always equals `candidates` unless something aborts mid-loop). |
| `succeeded` | Lat/lng was extracted and written to `WarehouseData`. |
| `failed` | Either no extraction method worked, or the DB write threw. |
| `durationMs` | Wall-clock duration of the handler. |

`CronRunLog.status` is derived as:
- `"ok"` — `failed === 0`
- `"error"` — every candidate failed
- `"partial"` — some succeeded, some failed (or warm-up failed before any work)

### 401 Unauthorized

```json
{ "error": "unauthorized" }
```

Header missing or doesn't match `Bearer ${CRON_SECRET}`.

### 500 Internal Server Error

```json
{ "error": "internal_error", "message": "<error message>" }
```

Only fires for unexpected exceptions reaching the central error handler
([`src/middlewares/errorHandler.mjs`](../src/middlewares/errorHandler.mjs)).
Per-row scraping failures are **not** 500s — they're counted in `failed` and
recorded in `GeocodeAttempt`.

### What the handler actually does

Implementation: [`src/services/cron/geocodeRecent.service.mjs`](../src/services/cron/geocodeRecent.service.mjs).

1. Start the timer.
2. Warm up the Google Maps session (fetch `google.com/maps`, collect
   cookies). If this throws, write a `partial` `CronRunLog` row with notes
   `warmup_failed: ...` and return early.
3. Run the pending query (`findPendingRecent`) — see the data model section
   below for the exact filter.
4. For each row, paced by 2s:
   - Call `extractCoordinatesFromUrl(googleLocation)`.
   - Open a Prisma transaction:
     - If lat/lng extracted: `upsertCoords` to `WarehouseData`, then
       `recordSuccess` on `GeocodeAttempt`.
     - Otherwise: `recordFailure` on `GeocodeAttempt` with `lastVia` and
       `lastError`.
   - Every 15 rows, re-warm the session (Google's heuristics seem to soften
     responses after a streak from the same cookie set).
5. Insert one `CronRunLog` row, return summary.

### Extraction methods (`via` values)

Written to `GeocodeAttempt.lastVia`:

| Value | Source |
|---|---|
| `url_@` | `@lat,lng` in the URL |
| `url_!3d!4d` | `!3d<lat>!4d<lng>` Maps URL params |
| `url_/search/` | `/search/<lat>,<lng>` paths |
| `url_ll=` | `?ll=lat,lng` query |
| `url_q=` | `?q=lat,lng` query |
| `url_dms` | Degree-minute-second encoded coords |
| `cid_lookup` | Extracted `!1s<ftid>` and resolved via `maps/preview/place` |
| `no_match` | URL parsed fine but none of the above matched |
| `error_resolve` | Shortened URL (`goo.gl`, `share.google`) didn't resolve |
| `error_cid` | `ftid` present but `preview/place` returned no coords |
| `error_thrown` | `extractCoordinatesFromUrl` threw — see `lastError` |

### Pending query — exact filter

From [`src/models/geocode/attemptRepo.mjs`](../src/models/geocode/attemptRepo.mjs):

A warehouse is a candidate iff:
- `googleLocation` is non-empty,
- `createdAt > now() - 7 days` **or** `status_updated_at > now() - 7 days`,
- `WarehouseData` row missing or `latitude`/`longitude` null,
- `GeocodeAttempt.succeededAt is null`, **and**
- no prior attempt **or** (`attemptCount < 5` **and** last attempt > 24h ago).

Ordering: most recently created/updated first.

The 5-attempt cap is the kill switch — after 5 failed daily runs, the
warehouse drops out of the candidate set forever (until you delete its
`GeocodeAttempt` row). Find stuck rows with:

```sql
select w.id, w."googleLocation", a."attemptCount", a."lastVia", a."lastError"
from "GeocodeAttempt" a
join "Warehouse" w on w.id = a."warehouseId"
where a."succeededAt" is null and a."attemptCount" >= 3
order by a."attemptCount" desc;
```

### Manual invocation

For testing or to catch up after a missed tick:

```bash
curl -X POST https://wareongo-cronjobs.duckdns.org/cron/geocode-recent \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json"
```

Or from Supabase SQL (one-off — copy from the commented block at the bottom
of `sql/pg_cron_setup.sql`).
