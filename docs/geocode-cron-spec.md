# Geocoding Cron Endpoint — Spec

A daily-fired HTTP endpoint that geocodes recently-added warehouses whose `googleLocation` URL has not yet been resolved to lat/lng. Triggered by Supabase's `pg_cron` + `pg_net` at **03:00 IST**. Maintains an audit trail so permanently-failing warehouses are not retried forever.

This supersedes the earlier Edge-Function-based spec. The worker is now a long-lived Node/Express endpoint living in this repo, structured as MVC so future cron jobs (DB backups, etc.) drop in alongside the geocoder without touching existing files.

---

## Goal

Keep `WarehouseData.latitude` / `WarehouseData.longitude` up-to-date as new warehouses are inserted with a `googleLocation` URL, **without** re-attempting rows that have repeatedly failed extraction (e.g. malformed Google Maps URLs that yield no `!1s` ftid, no `@lat,lng`, and no `!3d!4d`).

One-shot backfills of older rows are out of scope here — `scripts/geocode-all.mjs` remains for that.

---

## High-level shape

1. **Postgres** holds the source of truth for what's pending and what's been tried (`Warehouse`, `WarehouseData`, new `GeocodeAttempt`, new generic `CronRunLog`).
2. **Express endpoint** `POST /cron/geocode-recent` runs the extraction logic synchronously and writes results back. Hosted on a long-lived Node process (Render free web service — see Deployment).
3. **`pg_cron`** in Supabase fires `pg_net.http_post` once a day at 03:00 IST. Fire-and-forget; the next run picks up anything that didn't get processed.

Why an Express endpoint and not a Supabase Edge Function: Google Maps scraping needs 2s spacing between requests and occasional session re-warms; that does not fit Edge Functions' ~150s cap. A long-lived Node process can pace properly and reuse the existing scraping logic from `scripts/geocode-all.mjs` nearly verbatim.

---

## Decisions (locked)

| Decision | Choice | Rationale |
| --- | --- | --- |
| Schedule | Daily at **03:00 IST** | User-specified. Cron expression: `27 21 * * *` (UTC). The `:27` is off-the-hour to avoid shared-infra contention. Actual fire time ≈ 02:57 IST. |
| Scope per run | Warehouses created in the last **7 days** with no lat/lng | Bounds work to recent inflow. Older rows go through the offline backfill script. |
| Failure tracking | New `GeocodeAttempt` table, keyed `warehouseId` unique | Keeps audit data out of the domain table; supports per-warehouse `attemptCount`, `lastVia`, `succeededAt`. |
| Run logging | New **generic** `CronRunLog` table, shared by every cron job in this service | Avoids a per-job log table. Job-specific counts live in `metadata` JSON. |
| Retry policy | Skip warehouses with `attemptCount >= 5`, or `lastAttemptAt > now() - 24h`, or `succeededAt is not null` | Stops the daily retry of permanent failures; the 24h gate just protects against manual reinvocations. |
| Execution model | Synchronous: endpoint blocks until chunk done, returns summary JSON | `pg_net.http_post` is fire-and-forget anyway; sync makes the response body useful for ad-hoc curls and easier to debug. |
| Auth | Shared bearer secret in `CRON_SECRET` env var, checked against `Authorization: Bearer …` header | Symmetric, simple, sufficient for an internal endpoint Supabase calls. |
| Architecture | MVC (controllers / services / models / lib), feature-grouped under each layer | New cron jobs add files, not lines. See Module layout below. |
| Deployment target | Render free web service | Cheapest viable host; spin-down is invisible to a fire-and-forget cron. See Deployment. |

---

## Schema additions

Add to `prisma/schema.prisma`:

```prisma
model GeocodeAttempt {
  id            Int       @id @default(autoincrement())
  warehouseId   Int       @unique
  attemptCount  Int       @default(0)
  lastAttemptAt DateTime  @default(now()) @updatedAt
  lastVia       String?   // "url_@" | "cid_lookup" | "no_match" | "error_resolve" | "error_cid"
  lastError     String?
  succeededAt   DateTime?

  @@index([lastAttemptAt])
  @@index([succeededAt])
}

model CronRunLog {
  id         BigInt   @id @default(autoincrement())
  jobName    String   // "geocode-recent", future: "db-backup", etc.
  ranAt      DateTime @default(now())
  status     String   // "ok" | "error" | "partial"
  durationMs Int
  metadata   Json?    // per-job counts, e.g. { candidates, processed, succeeded, failed, scope }
  notes      String?

  @@index([jobName, ranAt])
}
```

Migration: `npx prisma migrate dev --name add_geocode_audit`.

`succeededAt is not null` is the kill switch on `GeocodeAttempt`: once a row has lat/lng, it is never reconsidered, even if `WarehouseData` is later wiped. The attempt row stays as audit history.

`CronRunLog` is intentionally generic. The geocode controller writes `metadata = { scope, candidates, processed, succeeded, failed }`; a future backup job would write `metadata = { bucketsBackedUp, bytes }`. Queries that want geocode-specific stats filter `where jobName = 'geocode-recent'` and dig into `metadata`.

---

## The pending query

```sql
select w.id, w."googleLocation"
from "Warehouse" w
left join "WarehouseData"   d on d."warehouseId" = w.id
left join "GeocodeAttempt"  a on a."warehouseId" = w.id
where w."googleLocation" is not null
  and w."googleLocation" <> ''
  and w."createdAt" > now() - interval '7 days'
  and (d.latitude is null or d.longitude is null)
  and a."succeededAt" is null
  and (
    a.id is null
    or (a."attemptCount" < 5
        and a."lastAttemptAt" < now() - interval '24 hours')
  )
order by w."createdAt" desc;
```

No `LIMIT` — last-7-days inflow is naturally bounded (typically <50). At 2s per request plus warm-up, even 200 rows finishes in ~7 minutes, which a long-lived Node process handles trivially. If a future spike pushes that to thousands, add `limit 200` here and let subsequent daily runs catch the tail.

---

## Endpoint

`POST /cron/geocode-recent`

- **Auth**: `Authorization: Bearer $CRON_SECRET`. 401 on mismatch.
- **Body**: ignored.
- **Response (200)**:
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
- **Response (401)**: `{ "error": "unauthorized" }`.
- **Response (500)** only for unexpected exceptions; per-row Google failures are *not* 500s — they're counted in `failed` and rolled into the audit log.

Flow:

1. Start timer.
2. Warm up Google session (one `GET https://www.google.com/maps` to pick up cookies).
3. Run the pending query → `candidates`.
4. For each row, paced by 2s:
   - `extractCoordinatesFromUrl(url)` (the existing logic, ported into `src/lib/googleMaps/extractor.mjs`).
   - Open a Prisma transaction:
     - If `lat != null`: upsert `WarehouseData` (set lat/lng), upsert `GeocodeAttempt` (`attemptCount += 1`, `lastVia = result.via`, `succeededAt = now()`).
     - Else: upsert `GeocodeAttempt` (`attemptCount += 1`, `lastVia = result.via`, `lastError = <short text>`).
   - Bump counters.
   - Every 15 rows, re-warm the session (matches `BATCH_SIZE` in `scripts/geocode-all.mjs:14`).
5. Insert one `CronRunLog` row with `jobName = "geocode-recent"` and counts in `metadata`. Return summary.

The 2s sleep and 15-batch re-warm carry over from the offline script because Google's heuristics haven't changed.

---

## Module layout (MVC, feature-grouped)

```
src/
├── index.mjs                                # entry: load env, start server, shutdown hooks
├── app.mjs                                  # build Express app, register middleware + routes (no .listen)
├── config/
│   ├── env.mjs                              # env var loading + validation (DATABASE_URL, CRON_SECRET, PORT)
│   └── prisma.mjs                           # singleton PrismaClient + pg pool
├── middlewares/
│   ├── requireCronAuth.mjs                  # Authorization: Bearer $CRON_SECRET check
│   └── errorHandler.mjs                     # central thrown-error -> JSON 500
├── routes/
│   ├── index.mjs                            # mounts /health, /cron
│   └── cron.routes.mjs                      # POST /cron/geocode-recent (+ future cron endpoints)
├── controllers/
│   └── cron/
│       └── geocodeRecent.controller.mjs     # HTTP layer: auth, validate, call service, shape response
├── services/
│   └── cron/
│       └── geocodeRecent.service.mjs        # business logic: warm session, loop, record run log
├── models/                                  # data-access layer (Prisma wrappers) — M in MVC
│   ├── cron/
│   │   └── runLogRepo.mjs                   # CronRunLog insert (shared by all cron services)
│   └── geocode/
│       ├── attemptRepo.mjs                  # GeocodeAttempt upsert + pending query
│       └── warehouseDataRepo.mjs            # WarehouseData lat/lng upsert
└── lib/                                     # cross-cutting non-domain code
    └── googleMaps/
        ├── session.mjs                      # BASE_COOKIE, BROWSER_HEADERS, warmUpSession
        └── extractor.mjs                    # extractCoordsFromString, resolveViaCid, extractCoordinatesFromUrl
```

Conventions:

- **Feature-grouped under each layer.** `controllers/cron/`, `services/cron/`, `models/geocode/`. When a `db-backup` cron lands, it gets `controllers/cron/dbBackup.controller.mjs` + `services/cron/dbBackup.service.mjs` + maybe `lib/storage/s3.mjs`. No existing file gets fatter; new ops add files, not lines.
- **`lib/` ≠ `services/`.** External-service clients (the Google Maps scraper) are reusable infrastructure, not workflow. If a second endpoint also needs Google Maps extraction, it imports `lib/googleMaps/extractor.mjs`. A future `lib/storage/` for backups slots in the same way.
- **`models/` = repository pattern.** Prisma already gives us types; this layer is a data-access boundary so services don't sprinkle raw Prisma calls everywhere. Pragmatic MVC for Node — Mongoose-style "Model = full ORM object" doesn't fit Prisma.
- **No `views/`.** It's a JSON API. Response shaping happens inline in controllers; if it grows, add `views/` for serializers.
- **`app.mjs` vs `index.mjs`.** `app.mjs` builds the Express app (testable, no `.listen()`); `index.mjs` boots it. Standard Node-Express convention; lets us add integration tests later without touching the entry.

The existing `scripts/geocode-all.mjs` can be refactored later to import from `src/lib/googleMaps/extractor.mjs` instead of duplicating the logic; out of scope for this change.

---

## pg_cron setup (Supabase SQL editor)

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Store endpoint URL and shared secret once
alter database postgres set app.settings.geocode_cron_url    = 'https://<your-render-service>.onrender.com/cron/geocode-recent';
alter database postgres set app.settings.geocode_cron_secret = '<CRON_SECRET>';

-- 03:00 IST daily = 21:30 UTC the previous day; we use 21:27 UTC to dodge :00/:30 herd
select cron.schedule(
  'geocode-recent',
  '27 21 * * *',
  $$
    select net.http_post(
      url := current_setting('app.settings.geocode_cron_url'),
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.settings.geocode_cron_secret'),
        'Content-Type',  'application/json'
      ),
      timeout_milliseconds := 900000
    );
  $$
);
```

To remove: `select cron.unschedule('geocode-recent');`.

Notes:
- `pg_cron` on Supabase runs in **UTC**, no DST handling. India does not observe DST, so 21:27 UTC ↔ 02:57 IST is stable year-round.
- `timeout_milliseconds := 900000` (15 min) leaves margin for Render's cold-start (~30–60s) plus the actual run.
- `timeout_milliseconds` is `pg_net`'s wait, not a hard kill — the endpoint keeps running regardless.

---

## Environment variables

| Var | Where | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | already in `.env` | Prisma connection. |
| `CRON_SECRET` | new, add to `.env` and Render env | Bearer token the endpoint checks against. Generate with `openssl rand -hex 32`. Also stored in Postgres via `app.settings.geocode_cron_secret`. |
| `PORT` | already handled (Render sets it automatically) | Express port. |

---

## Deployment — Render free web service

**Plan: Free web service** (`*.onrender.com`, 512 MB RAM, 0.1 vCPU, 750 hr/mo, auto-TLS, free IPv4).

Why Render free, not EC2 / Lambda / Fly / Railway:
- Daily ~3-minute job → an always-on VM is overkill. `t4g.nano + IPv4 + EBS` ≈ $7/mo on AWS, mostly the IPv4 surcharge. Render gives the same shape for $0 with no IPv4 charge.
- Lambda's 15-min cap fits, but per-invocation cold cookies make Google scraping flakier — exactly the reason we moved off Edge Functions.
- Fly/Railway both work; Render's free tier just costs less and we don't need scale-to-zero semantics.

Fit check vs. the workload:

| Constraint | Limit | Our usage | Verdict |
| --- | --- | --- | --- |
| RAM | 512 MB | Node + Prisma client + pg pool ≈ 150–250 MB RSS | Fits |
| CPU | 0.1 vCPU | Network-bound (2s sleeps); regex parsing is trivial | Fits |
| Hours/month | 750 | ~5 min/day = ~2.5 hr/mo (active); idle counts but well under 750 | Fits |
| Build minutes | 500/mo | ~1 min per deploy | Fits |
| Spin-down | After 15 min idle | Daily cron always cold-starts | See below |
| Public IPv4 | Included free | No AWS-style surcharge | Win |
| TLS | Auto, free | — | Win |

### The spin-down "problem" isn't a problem

Render free web services spin down after 15 min of no traffic. The next request triggers a ~30–60s cold start. For most apps that hurts; for us it's invisible:

- `pg_net.http_post` waits up to `timeout_milliseconds`. We set it to 15 min — cold start + 3-min job ≈ 4 min, well inside.
- No human is on the other end. The audit result shows up in `CronRunLog` afterwards.

### Caveats worth knowing

1. **Google Maps scraping from Render egress IPs is empirical.** Google's bot heuristics treat cloud-provider IP ranges more harshly than residential / DC IPs in India. The existing `scripts/geocode-all.mjs` presumably ran from a laptop or another box; whether it still works from Render is something we'll only know after deploying. Failure mode is graceful — the `GeocodeAttempt` table records via codes (`error_cid`, `no_match`), and the 5-attempt cap stops runaway retries. Watch `CronRunLog.metadata.failed` for the first few runs. If failure rate spikes, the design lets us move hosts without losing audit state.
2. **No shell access on free tier.** Debug via `console.log` → Render's log dashboard. Tolerable for an audit-logging cron.
3. **Logs retained 7 days on free.** Anything longer-lived must live in `CronRunLog` (which is the entire point of the audit table — design already covers it).
4. **No persistent disk.** We don't need one — state lives in Postgres.
5. **Build command**: `npm install && npx prisma generate`. **Start command**: `npm start` (which runs `node --experimental-strip-types src/index.mjs`).
6. **Health check**: point Render at `/health`. The endpoint already exists and pings the DB.

### When to leave Render free

- Failure rate from IP reputation makes the job unusable → move to a host with a different egress range (Fly.io in BOM, a small VPS, or self-host).
- Multiple concurrent cron jobs push past 512 MB → Render starter ($7/mo) or t4g.micro.
- Cold-start variance becomes operationally annoying → starter plan keeps the dyno warm.

---

## Observability

Three places:

1. `CronRunLog` (this repo's DB) — every invocation across every cron job, with counts and duration in `metadata`.
2. `cron.job_run_details` (Supabase) — whether the cron tick fired.
3. `net._http_response` (Supabase, `pg_net` schema) — the response body the endpoint returned, including `runId` for cross-referencing.

Useful queries:

```sql
-- Last 14 geocode runs
select id, "ranAt", status, "durationMs", metadata
from "CronRunLog"
where "jobName" = 'geocode-recent'
order by "ranAt" desc limit 14;

-- Stuck warehouses (attempted ≥ 3 times, never succeeded)
select w.id, w."googleLocation", a."attemptCount", a."lastVia", a."lastError"
from "GeocodeAttempt" a
join "Warehouse" w on w.id = a."warehouseId"
where a."succeededAt" is null and a."attemptCount" >= 3
order by a."attemptCount" desc;

-- Did today's cron fire?
select * from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'geocode-recent')
order by start_time desc limit 5;
```

---

## Failure modes

| Failure | Behavior |
| --- | --- |
| Google rate-limits warm-up | Service returns 200 with `processed: 0`. `GeocodeAttempt` rows untouched — pending set unchanged for tomorrow. `CronRunLog.status = "partial"`. |
| `extractCoordinatesFromUrl` throws | Per-row try/catch records `lastVia = "error_thrown"`, `lastError = err.message`, increments `attemptCount`. Loop continues. |
| Endpoint 500s mid-run | Already-processed rows are committed (per-row transaction). Tomorrow's run picks up the rest. `CronRunLog.status = "error"` if we got far enough to write it. |
| Endpoint unreachable | `pg_net` records the failure; `cron.job_run_details` shows the tick succeeded (the SQL ran) but `net._http_response` shows the timeout. Next day's tick will try again. |
| Render dyno cold-starts past `pg_net` timeout | Endpoint still completes (Node keeps running); `CronRunLog` gets the row. The `net._http_response` row just won't have the body. Bump `timeout_milliseconds` if this happens. |
| Permanent `no_match` for a real URL | After 5 attempts (5 days), warehouse drops out of the pending query forever. Shows up in the "stuck warehouses" diagnostic query above. Reset by deleting the `GeocodeAttempt` row. |

---

## Adding a new cron job later

The MVC structure is the contract. To add, e.g., a nightly DB backup:

1. New service: `src/services/cron/dbBackup.service.mjs` — pure logic, takes deps via params or imports from `lib/`.
2. New controller: `src/controllers/cron/dbBackup.controller.mjs` — auth check (reuse `requireCronAuth`), call service, write `CronRunLog` with `jobName = "db-backup"`, shape response.
3. New repo (if needed): `src/models/<feature>/...` for any new tables.
4. New `lib/` module (if needed): e.g. `src/lib/storage/s3.mjs`.
5. Mount the route in `src/routes/cron.routes.mjs`.
6. Add a `pg_cron` schedule in Supabase pointing at the new path.

No changes to existing geocode files. That's the whole point of the layout.

---

## Open questions / decisions to revisit

1. **Attempt cap of 5** is a guess. If 5 days of transient Google failures looks possible, raise to 10 or add error-class-aware retry (e.g. `error_resolve` retried longer than `no_match`).
2. **24h retry gate** is redundant with daily-only scheduling; kept as a safety net against manual reinvocation. Remove if we start running the endpoint more frequently.
3. **Backfill of older rows** still goes through `scripts/geocode-all.mjs` (long-lived Node process, paced properly). The cron endpoint deliberately does not touch rows older than 7 days so a sudden surge of legacy unmapped warehouses doesn't blow up the daily run.
4. **Render egress IP reputation with Google** is the single biggest unknown. Track `CronRunLog.metadata.failed / candidates` for the first ~2 weeks. If the ratio spikes vs. the offline script's baseline, the host is the problem, not the URLs.
