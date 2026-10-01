# Queue integration and Supabase setup

Status: local implementation, 30 September 2026. Production still processes
through the existing EC2 crons. This work does not install production SQL,
change production settings, push commits, or deploy either backend.

## Flow and boundaries

A committed warehouse/media/coordinate change produces an ID-only
`refresh-warehouse` event through separately enabled source triggers. Refresh
rereads current media, registers missing images, and creates jobs in pages of ten
images. The cursor and child jobs commit together. Original media stays intact.
Label/caption, website approval and WebP are independent jobs. Document subtype
waits for classification; proximity waits for coordinates. JPEG remains an explicit
request, using the existing 1280px photo / 1920px document policy.

One worker reserves the shared memory/execution slot before claiming one job;
there is no prefetched image buffer. Existing download, decoder and systemd caps
remain. Short database transactions check current source membership/coordinates,
image or attempt ownership, and the current PGMQ receipt before publication.
Provider calls/encoding happen outside transactions. Source edits, superseded
claims and manual privacy overrides reject stale results.

Acknowledgement archives the job and creates follow-ups atomically. Redelivery
uses stored results and reconstructs dependencies. A crash after an external call
but before publication can still repeat that call: delivery is at least once,
not a guarantee of exactly-once provider billing.

| Component | Responsibility |
|---|---|
| `src/lib/queue/` | Message contract, settings and diagnostic CLI |
| `src/models/queue/repository.mjs` | Private PGMQ operations and receipt checks |
| `src/models/queue/actionContext.mjs` | Source locks, leases and attempt accounting |
| `src/models/queue/actionRepositories.mjs` | Guarded adapters for all seven actions |
| `src/services/queue/dispatcher.mjs` | Eligibility, prerequisites and persisted-result checks |
| `src/services/queue/refresh.mjs` | Registration and resumable, bounded fan-out |
| `src/services/queue/consumer.mjs` | Serial admission, fairness, deadlines and drain |
| `src/services/queue/runtime.mjs` | Startup/shutdown and exclusive worker session lock |
| `deploy/backup/` | Consistent, streamed domain/queue backup and isolated restore |

Normal HTTP/CLI/cron calls use `deliveryServices.mjs`. Explicit HTTP/CLI requests
enqueue independent intent; only cron reconciliation coalesces pending work.
This prevents a new request from disappearing when an older in-flight job is
acknowledged. Only the dispatcher invokes
`runQueued`; passing inline `services.run` to the consumer would bypass guards
and reserve the executor twice. The diagnostic planner caps previews at 200 image
slots; the actual refresh handler pages instead. Coverage and retry eligibility
are rechecked when a job runs, so previews do not guarantee provider execution.

Image stages keep their five-attempt policy. Geocoding keeps its seven-day scope,
five attempts and 24-hour spacing, reserving before calling the provider. JPEG
has five attempts; proximity retains its 15-minute-to-six-hour cooldown. Their
leases/counters use existing `CronRunLog` metadata; no extra domain columns.
Waiting/configuration deferrals do not consume the separate delivery-error budget.
The enrichment reconciliation sweep prunes at most 1,000 archived jobs older
than 30 days per run. Dead letters are retained.

## Modes and retained crons

| Settings | Processing | Schedules |
|---|---|---|
| `cron`, `worker` (defaults) | Existing inline handlers | Existing behavior |
| `shadow`, `worker` | Inline handlers; no consumer | Existing behavior while source events accumulate |
| `queue`, `worker` | One guarded queue worker | Reconcile/enqueue; no inline provider calls |
| Any mode, `api` | Read-only health/status/previews | Action execution and cron starts rejected |

`ENRICHMENT_DELIVERY_MODE` defaults to `cron`; `ENRICHMENT_PROCESS_ROLE` defaults
to `worker`. The release helper forces its temporary canary to `api` regardless
of the production environment. Consumption requires queue mode plus worker role.
The worker requires a direct or session-pooler database connection; port 6543 is
rejected because leadership uses a session advisory lock. Losing that connection
stops work and fails health. A ten-second heartbeat checks the same backend still
holds the lock, and a 45-second server idle timeout bounds abandoned sessions.
Three consecutive failed polling cycles fail health; a successful poll recovers it.
Actions have a cooperative three-minute deadline
inside five-minute visibility; shutdown drains before closing database connections.

Keep crons processing throughout shadow observation. At cutover stop/drain inline
work before switching to queue mode. Keep the schedules as reconciliation and
keep inline handlers for rollback. Backup and unrelated schedules continue.
Do not run cron provider execution alongside an active queue worker.

## Supabase and deployment

The read-only check on 30 September found PGMQ 1.5.1 available but uninstalled,
and the existing server login able to create objects/manage roles. Use the
existing `DATABASE_URL`, provider credentials and `BACKUP_DATABASE_URL`: no new
Supabase API key, AWS key or R2 key is needed. Keep `pgmq` and `enrichment` private;
never grant browser roles access or expose these schemas through PostgREST.

1. Deploy the dashboard's atomic staged approval. Warehouse, coordinates, approval
   link and any capture event must commit or roll back together.
2. Update the installed root-owned EC2 deployment helper, then deploy the enricher
   in default cron mode. A git push alone does not update that privileged helper.
   Verify its API-only canary, non-root backup/failure services (384 MiB caps),
   and a successful backup/isolated restore.
3. As extension/schema owner, run `sql/queue/001_bootstrap.sql`, then
   `002_capture_functions.sql`. Both are additive and repeatable; neither attaches
   source triggers. Unsupported PGMQ versions fail. Do not use `prisma db push`.
4. Run `npm run queue -- doctor`. `ready` checks transport schema/permissions;
   `actionAdaptersAvailable` describes the binary, not deployment readiness.
   A separate backend login needs `enrichment_queue_worker` membership plus domain
   permissions. This NOLOGIN role is not a new credential.
5. After approval/deployment/backup checks, enable `003_enable_capture.sql` and
   use shadow mode. Confirm committed source edits enqueue, rolled-back edits do
   not, and source-write latency/backlog remain acceptable. Crons still process.
6. Follow the execution window and observation gates in [QUEUE_ROLLOUT.md](QUEUE_ROLLOUT.md).
   For the supervised trial set `ENRICHMENT_QUEUE_TRIAL_SUBJECTS` to JSON with
   explicit `warehouseIds` and registry `imageIds` arrays. Unselected jobs remain
   durable and are deferred five minutes without provider calls or attempt use.
   Malformed/empty restrictions fail startup. Keep the trial brief; remove the
   setting completely after validation to enable normal processing.

Rollback: stop/drain the queue worker, restart in cron/shadow mode, and retain all
queue/domain data. `004_disable_capture.sql` detaches only source triggers; it
does not stop consumption. Keep queue-aware backups through application rollback.

## Commands and HTTP

```bash
npm run queue -- doctor
npm run queue -- stats
npm run queue -- plan --warehouse-id=2748
npm run queue -- plan --warehouse-id=2748 --include-jpeg
npm run queue -- enqueue --action=webp --id=123 --lane=backfill --dry-run
```

Doctor/plan are read-only. Dry-run enqueue validates without querying; removing
that flag writes a job but never starts a consumer. Image actions use registry
IDs; geocode/proximity use warehouse IDs. Normal action POSTs return HTTP 202 with
`status: QUEUED` in queue mode. Cron acceptance means reconciliation started, not
that all child work completed. Authenticated `GET /queue/status` reports runtime
and aggregate queue state; inspect domain stages/attempt logs for individual work.

## Local verification

Use `npm ci` and `npm run generate`. Tests use disposable PostGIS 17, pinned PGMQ
1.5.1 and stubbed providers, with no paid calls or R2 uploads. The installer
`tests/fixtures/install-pgmq.py` verifies upstream SQL against a pinned SHA-256.

Set `ENRICHER_TEST_DATABASE_URL` for localhost `enricher_test`,
`ENRICHER_QUEUE_TEST_DATABASE_URL` for localhost `enricher_queue_test`, and
`ENRICHER_BACKUP_TEST_DATABASE_URL` for the same local `enricher_test` cluster.
Backup tests create/drop only `enricher_backup_test` and `enricher_restore_test`.
For container client tools, set `ENRICHER_TEST_ENGINE=podman` (or docker) and
`ENRICHER_TEST_CONTAINER`. CI supplies all three database variables. Without them,
those suites skip; unit-only output is not complete verification.

Coverage includes seven real action handlers, stale sources/receipts, privacy
overrides, retry limits and crash leases, large paged fan-out, API-only canaries,
worker ownership loss, and a concurrent-write backup/restore round trip. Dashboard
approval/reopen database race tests run separately. See [QUEUE_BACKUP.md](QUEUE_BACKUP.md).

See [the local adversarial review](QUEUE_ADVERSARIAL_REVIEW.md) for reproduced
failure cases, corrections, verification and remaining production gates.
