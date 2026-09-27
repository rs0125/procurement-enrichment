# HTTP API

Production base: `https://wareongo-cronjobs.duckdns.org` (Caddy fronts Node on
port 3000). Explicit actions are documented in [Enrichment services](ENRICHMENT_SERVICES.md);
image/proximity and WebP schedules are in [Scheduled enrichment](CRON_MIGRATION.md).

`GET /health` is public. It returns `200 {"status":"ok","db":"connected"}`
or a generic `503` response without private database error details.

## Nightly geocoder

`POST /cron/geocode-recent` requires `Authorization: Bearer <CRON_SECRET>`.
The Supabase schedule remains **21:27 UTC / 02:57 IST** and its stored command
and credentials do not change. Send `{}` or no body.

The route now acknowledges a persisted run immediately with **202**:

```json
{"status":"accepted","jobId":"42"}
```

Concurrent triggers return `{"status":"already_running","jobId":"42"}`.
The database run lock prevents independent processes from starting another
nightly sweep. Work continues independently of the triggering HTTP connection.
`POST` with `{"dryRun":true}` returns a read-only candidate preview instead.

`GET /cron/geocode-recent`, with the same authentication, returns the latest
run status, job ID, start time, duration and progress. Progress includes
`scope: "recent-7d"`, `candidates`, `processed`, `succeeded`, `failed`, `skipped`,
`deferred`, and `morePending`. New log statuses use the shared cron convention:
`RUNNING`, `SUCCESS`, `PARTIAL`, `FAILED`, or `INTERRUPTED`. Historical `ok`,
`partial`, and `error` rows are retained.

A run selects at most **100 candidates**, has a **10-minute budget**, and shares
the single memory-gated action executor with image and proximity work. Calls
are paced by two seconds; aborting the run interrupts the pause and provider
requests. Shutdown aborts and drains the geocoder along with the other crons.
Excess/unprocessed work stays eligible for the next scheduled or manual run.

Candidate eligibility is unchanged:

- nonempty Maps URL;
- created or status-updated in the last seven days;
- missing latitude or longitude;
- no successful geocoding attempt;
- no attempt yet, or fewer than five attempts with the last attempt over 24 hours ago.

The shared geocode action validates finite latitude/longitude bounds. Before
publishing, it checks that the Maps URL and coordinates still match its snapshot.
Concurrent URL/coordinate edits therefore survive. Failed lookups update
`GeocodeAttempt` only if that snapshot still matches; cancelled/deferred work
does not consume an attempt. Invalid input/provider failures never store
coordinates. Successful publication and its attempt record commit together.

Unauthorized requests return 401, invalid request bodies 400, and unavailable
cron acceptance/status 503. Error responses do not include provider or database
exception messages.

Implementation: [cron service](../src/services/cron/geocodeRecent.service.mjs),
[shared action](../src/services/enrichment/geocode.mjs),
[publication repository](../src/models/geocode/singleRepository.mjs).
