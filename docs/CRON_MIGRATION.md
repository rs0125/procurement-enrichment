# Scheduled enrichment before queues

The existing triggers call bounded batches on this EC2 service. There is no
durable queue or producer change. Each image action still has its own entry point.

| Trigger | Enricher route | Work |
|---|---|---|
| Supabase `sweep-warehouse-image-labels`, every 15 minutes | `POST /cron/enrichment` | Scene labels, document kinds, website approvals, proximity |
| CMS nightly website build, 20:30 UTC / 02:00 IST | Website backend forwards `/maintenance/webp` to this service | WebP inventory, due compression, legacy projection repair |
| Supabase `geocode-recent`, 21:27 UTC / 02:57 IST | `POST /cron/geocode-recent` | Existing recent-warehouse geocoder |
| systemd backup timer, 22:30 UTC / 04:00 IST | No HTTP route | Existing database backup |

The CMS still starts its website build independently. No rebuild is triggered by
image processing. JPEG remains an explicit action; there was no JPEG cron to port.

## Batch behavior

`/cron/enrichment` runs label → document subtype → website approval → proximity,
with caps of 50, 50, 12 images and 5 warehouses. The overall work budget is ten
minutes, with smaller stage budgets. A failed stage does not suppress unrelated
stages. `/cron/webp` has a 45-minute budget and processes at most 500 images.
Both return HTTP 202 after the existing `CronRunLog` table records the run;
acceptance does not mean the work succeeded. GET on the same route returns the
last run and its final counts. POST with `{"dryRun":true}` only reads backlog and
configuration. These routes use the existing `CRON_SECRET` bearer.

The compatibility `/maintenance/webp` GET/POST uses the existing scoped HMAC
credential from the website backend. It accepts no raw R2 key. The website backend
forwards requests and never starts a second local compressor if EC2 is unavailable.

One image/proximity action executes at a time. Overlapping batches wait within
their own time budget before invoking the next action; they do not preclaim images
or store a queue of payloads. Native compression retains the existing disk buffers,
decoder child, memory admission checks and systemd memory limit. Restart/shutdown
aborts work, waits for cleanup and records a partial run when possible. A crashed
run's lock expires after its work budget plus five minutes.

The label and website run names match the old dashboard locks. Existing stage
claims, retries, attempt limits and completed/manual/Sol reviews are retained.
Proximity uses the same cooldown metadata and preserves current highway distances
and terminal answers. A 1e-9 degree tolerance avoids repeated routing caused by
floating-point serialization; genuine coordinate edits still invalidate results.

WebP repair requires a complete R2 listing and compares the original object key
and full-precision checked timestamp before resetting a missing object. It never
deletes R2 objects or clears original URLs. Projection repair runs even when there
is no compression backlog, fences concurrent media edits, and preserves null slots.
`Warehouse.media` and raw storage remain intact. No schema migration is needed.

## Deployment and handoff

1. Run local tests against disposable PostGIS, then push the enricher. Wait for
   CI and EC2 CD to pass. Verify both cron previews and their configuration.
2. Verify the old website WebP job is not running, then deploy the website
   backend handoff. The CMS route, schedule and credential remain unchanged.
   Verify authenticated GET/POST still reach the new job.
3. On EC2, with the existing application environment, run
   `node --experimental-strip-types scripts/migrate-enrichment-cron.mjs` to inspect
   the redacted plan, then the same command with `--apply`.
   The script checks the new route before updating only the existing job's URL
   and authentication. Job ID, schedule, body, timeout and active state are retained.
   It rejects concurrent cron edits and unexpected destinations. The original
   command is saved privately at `/var/tmp/warehouse-enricher-cron-handoff.json`
   (mode 0600). Never print or commit that file: it contains the old credential.
4. Observe a real run of both batches and the next scheduled enrichment run.
   Inspect `CronRunLog` status, counts, retry backlog, duration and host memory.
   `metadata.executor = 'warehouse-enricher'` identifies migrated parent runs.

For rollback, restore only this job's previous `command` with `cron.alter_job`
using the private snapshot; check its job name and ID before doing so. Restore the
website backend's previous handoff revision only after stopping/draining the EC2
WebP batch. Never run two independently scheduled WebP workers deliberately.
The image claims protect interrupted work; no data rollback is required.

## Stability gate before queue work

Keep these crons through at least two nightly cycles. Verify scheduled parent runs
finish, new photos progress through the same policies, completed results do not
repeat, due work drains, retry failures are understood, and the geocoder/backup
continue to run. Check for service restarts or memory pressure. A successful empty
batch alone does not demonstrate provider or compression health. Only then add
durable queue delivery and change producers.
