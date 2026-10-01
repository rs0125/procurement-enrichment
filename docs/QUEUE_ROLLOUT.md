# Queue migration: implementation, verification and rollout

Status: **implementation local; production rollout pending, 30 September 2026**. This document does not authorize or
perform production schema/trigger changes. Implement the
[architecture](QUEUE_ARCHITECTURE.md) and [delivery contract](QUEUE_CONTRACT.md)
in small reviewed steps, retaining working cron delivery until its replacement
has passed the gates below.

Implementation update, 30 September: [QUEUE_SETUP.md](QUEUE_SETUP.md) records the
seven guarded action adapters, paged refresh, durable retry accounting, worker
lifecycle/canary isolation, atomic dashboard approval and consistent backup/restore.
Local integration gates are implemented and tested, including the
[adversarial review](QUEUE_ADVERSARIAL_REVIEW.md). Production baseline, updated
installed helper, deployment, SQL/grants, shadow observation and execution checks
remain. Crons stay active through shadow and become reconciliation at cutover.

Source baseline inspected: enricher `f4ba72f`, dashboard cleanup `85793e0`, and
website backend cleanup `da6a906`. Existing local bulk-geocoding and other unrelated
work is outside this plan. This documentation pass does not newly certify live
cron stability or current infrastructure measurements.

The [PGMQ evaluation](PGMQ_EVALUATION.md) selects PGMQ as the proposed transport.
Its local primitive tests are complete; production integration and the gates
below remain outstanding.

## Phase 0: establish the baseline

Record two completed nightly cycles after the cron migration, including actual
provider/encoder work, understood failures, no unexplained restarts/OOM events,
successful geocoding and successful database backups. An empty successful batch
is insufficient. Retain a small set of warehouse/image IDs for output comparison.

Measure new-media arrival rate, stage duration p50/p95, backlog/oldest eligible age,
provider calls, memory peaks, disk space and connection use. Inventory all callers
of the action CLI/HTTP routes and direct maintenance scripts. Record which need
synchronous results before choosing the asynchronous compatibility change.

Gate: the current pipeline is trustworthy enough to distinguish a queue regression
from existing source/provider failures. Planning and local fixture work can proceed
before this gate; production consumer activation cannot.

## Phase 1: make the action boundary reusable

In `warehouse-enricher`:

- Extract geocoder and proximity eligibility/cooldowns from cron-only selection.
  Keep behavior identical under the existing crons before adding a consumer.
- Add a typed internal disposition with specific retry/dependency/terminal reasons.
  The current combined `ready_ineligible_or_claimed` response needs a state re-read;
  a HTTP 200 is not queue success.
- Introduce internal queue-context publication guards in the action repositories.
  Keep source and existing image-stage guards; add queue fencing for JPEG,
  geocode and proximity. Cron execution remains available for rollback.
- Refactor executor reservation so claim and execution acquire the slot **once**.
  Do not reserve the current executor and then call `services.run()` in a way that
  acquires it again and permanently returns `worker_busy`.
- Define follow-up planning after stored/previously-stored results, so label →
  document/JPEG and geocode → proximity survive a crash between publication and
  queue acknowledgement.

In the dashboard backend, make staged warehouse creation and the approval link
transactionally consistent, preserving existing reviewer/reopen race protection.
Do not place R2 uploads or external calls inside that transaction. An immediate
consumer must never see a provisional promotion that is later compensated away.

Gate: existing action/cron tests pass unchanged in meaning, plus regression tests
for source edits, current retry windows, staged rollback/reopen and queue-context
rejection. No queue producer or consumer is enabled in production yet.

## Phase 2: build the queue locally

Use disposable PostGIS with the project-supported PGMQ version. Add fixed queues,
restricted receipt/source functions and migration verification. Write narrow source-trigger
functions but leave production triggers unattached until Phase 4. Do not use
`prisma db push`, recreate shared tables, alter `Warehouse.media`, or add variant
columns as part of this delivery change.

Implement the PGMQ adapter, consumer, source planner, domain retry integration
and status reporting. Reuse the [local fixtures](../experiments/pgmq/README.md),
then add the full action/publication race tests. Do not implement the earlier
custom generation-slot table alongside PGMQ. Duplicate delivery must reuse current
results and preserve attempts; `read_ct` alone cannot be a paid-attempt budget.

Use bounded per-warehouse planning and paged fleet reconciliation. Inspect actual
media cardinality and test an oversized fixture before deciding whether a small
planner checkpoint is needed. Never disguise truncated fan-out as success.

Gate: the failure matrix below passes, claim queries use expected indexes, grants
exclude public/browser roles, and forced crashes leave recoverable work.

## Phase 3: make deployment and backup queue-aware

Do this **before** any release can poll production work. The current privileged
helper starts a health canary with the production environment. An automatic
consumer added to module initialization would start a second production worker
during every deployment.

Required deployment contract:

1. Delivery defaults to cron and role defaults to worker, preserving existing
   deployments. Queue consumption requires queue mode plus worker role. The
   updated installed helper explicitly forces the canary to API-only regardless
   of inherited environment or delivery mode. Install it before queue mode.
2. Use one delivery mode: `cron`, `shadow` or `queue`. In cron/shadow, cron owns
   provider execution and no queue consumer claims work. In queue mode, cron paths
   reconcile/enqueue only. Unknown configuration fails closed for processing.
3. Shadow captures events and reports readiness without processing them. It is not
   permission to make duplicate model calls for comparison.
4. The canary may serve health and read-only previews, but cannot claim, enqueue,
   run paid actions or mutate queue state. Merely using another port is not enough.
5. Promotion stops claims, aborts/drains the current action and its child process,
   preserves leases on uncertain cleanup, then starts one consumer in the new
   release. Keep the existing 21:15–22:45 UTC protected deployment window.

Update both the versioned helper and the installed root-owned helper through the
existing administrative path, and test helper rollback. Do not assume a git push
replaces that privileged installed file. No new broad GitHub AWS permissions or
long-lived credential is necessary for this architectural change.

The implemented [backup and restore helper](QUEUE_BACKUP.md) exports domain and
PGMQ state from one snapshot with streamed COPY files, preserving private schema,
archive/dead letters, claim state and sequences. Its local round-trip test passes.
The root helper installs it outside application releases so rollback keeps queue
backups. Confirm actual daily S3 backup and an isolated production-shaped restore
before enabling capture/consumption; ordinary pg_dump alone remains insufficient.

Gate: production-environment canary tests prove zero queue mutations/provider
calls; old/new service overlap is bounded and harmless; private queue schema,
functions and permissions survive the tested backup/restore procedure.

## Phase 4: capture durable intent, with cron still processing

Apply the reviewed additive migration with short lock timeouts and before/after
checks. Enable the narrowly scoped source triggers only after the staged-promotion
fix is deployed. A source transaction must either commit both its write and refresh
intent or roll back both. Test returned API errors for a failed outbox write.

Run in shadow mode. Seed **missing work only** using paged, restartable discovery;
do not reset READY/approved/reviewed rows, and do not recompress existing variants
to populate the queue. Rows completed by crons can remain in the shadow backlog;
consumer startup will recognize their completed domain state without another call.
Track that distinction rather than interpreting shadow queue depth as paid backlog.

Test events from normal warehouse create/edit, imports/direct SQL, approved staging,
coordinates and deletion. Retain the existing post-commit registration hook and
cron reconciliation during this phase. Compare durable requests with committed
source changes, and measure trigger latency and DB load under a realistic burst.

Gate: no committed tested source change loses its event; aborted writes/promotions
leave no actionable provisional source; queue capture causes no material write
latency regression; all old consumer fallbacks still work.

## Phase 5: restricted production execution

The runtime now supports `ENRICHMENT_QUEUE_TRIAL_SUBJECTS`, containing explicit
`warehouseIds` and registry `imageIds` arrays. It defers other subjects five minutes
without paid attempts or provider calls. Invalid/empty settings fail startup.
The same number in the two ID namespaces is not interchangeable. For a refresh
trial, include the warehouse's existing registry IDs; newly registered IDs remain
queued until explicitly added or the restriction is removed. Keep this temporary
window small and supervised: excluded jobs still cause claim/defer database work.
Normal queue processing omits the setting entirely. Schedule the supervised window outside geocoding/backup. Drain existing
processing sweeps, put all legacy provider execution into enqueue-only mode, and
enable the queue for a small operator-selected fixture set. Keep other captured
work durable while that test is restricted; set a time/backlog limit on the window.
Do not run old sweeps and new consumers as two independent provider owners.

Include a photo, document, blocked contact-board image, allowed poor-quality photo,
shared image, missing-coordinate warehouse and changed-coordinate warehouse.
Exercise explicitly requested JPEG work without enabling fleet-wide JPEG.
Compare results, labels, website selection and a compressed PPT against baseline.

Verify the status route reports queued/running/ready/dead truthfully. A parent
maintenance dispatch completing is not proof every image is compressed. Update
the action CLI and known HTTP callers for enqueue/status behavior; inline
non-dry-run access is disabled or routed through the same queue in queue mode.

Gate: useful work completes once under normal operation, crash recovery/fallbacks
are demonstrated, and paid calls/outputs can be attributed to the intended work
IDs. If the window exceeds its bound, return to cron mode using the rollback below.

## Phase 6: widen and simplify

Remove the temporary subject restriction, retaining one active action and the
current caps. Observe at least two full nightly cycles under queue ownership,
including reconciliation, WebP inventory/projection repair, geocoder eligibility,
website builds and backup. Evaluate new versus backfill queue age and provider spend.

Only then remove duplicated post-commit registration if replaced successfully,
and consider reducing reconciliation frequency. The small recovery sweeps remain.
Keep the EC2 cron execution implementation available through the initial rollback
period; do not restore the removed dashboard/Render workers.

Consider automatic JPEG for newly registered images as a separately measured
extension. Increasing concurrency, adding another host or introducing a broker
is also a later capacity decision, not part of the first cutover.

## Acceptance and fault matrix

| Scenario | Required evidence |
|---|---|
| Source save commits/rolls back; trigger insert fails | Commit has durable intent, rollback has neither, and clients never receive false acceptance |
| Duplicate trigger/request and duplicate consumer delivery | Duplicate messages/delivery reuse results; no reset of cooldowns, attempts or completed decisions |
| Source edited during refresh or paid execution | New notification remains durable; stale output cannot replace new source facts |
| Two claimers, expired receipt, delayed provider response | Exclusive delivery and receipt/source-guarded publication, including JPEG/geocode/proximity |
| Crash before call, after call, after R2 upload, after DB publication, before dependency/ack commit | Recoverable state at each boundary; stored result/object reused where possible; uncertain provider billing documented |
| Scene failed/unsupported; prerequisite later succeeds | No hot-loop dependency retries; already-requested subtype/JPEG work wakes correctly |
| BLOCK/REVIEW/manual/Sol result | Completed decision retained; retry cannot turn a privacy rejection into a fallback image |
| Shared URL, reordered list, explicit empty media, warehouse deletion | Current global membership and slot alignment preserved; no original deleted |
| Old Maps attempt, changed valid coordinates, missing OSM coverage | Existing scope/cooldowns and coordinate tolerance preserved; no automatic expensive fleet rerun |
| Provider outage/429, DB disconnect, low RAM/disk, huge image | Bounded backoff and connections/buffers; unrelated actions still progress; no retry storm |
| Busy queue during release, canary, SIGTERM or host restart | One active producer of side effects, cleanup within bounds, incomplete jobs not acknowledged |
| WebP inventory is incomplete; projection/cache update fails | No false missing-object reset; projection repairs without another paid/encode action |
| Private schema restore; old claims in restored dump | Consumer stays off until fenced recovery; permissions and objects restored |
| New sources plus sustained backfill | Bounded fairness and no starvation by action; memory remains independent of queue depth |
| Unauthorized request/public DB role | No enqueue, queue read, retry reset or provider action |
| API and static website/PPT consumption | Approval rules and variant/original fallbacks match the baseline; static changes wait for a build |

Use fixture providers and local PostGIS for destructive/crash tests. Validate real
Sharp output locally. A small supervised production sample validates credentials
and integration, not the entire failure matrix. Do not repeat full backfills merely
to demonstrate that queue delivery works.

## Operational signals and initial thresholds

Expose authenticated counts and oldest runnable age by action/lane, deferred
reasons, oldest expired lease, DEAD count, processing p50/p95, result reuse,
provider errors/usage, process memory/OOM/restarts and database pool pressure.
Distinguish waiting for retry/dependency from work that is runnable but neglected.

Proposed starting alerts, to tune against Phase 0 measurements:

- Consumer has not completed a successful poll for two minutes while worker role
  is enabled; exclude deliberate pause/deployment from the page condition.
- Oldest runnable LIVE work exceeds 15 minutes, or runnable BACKFILL work one hour.
- A lease remains expired for more than two minutes without recovery.
- New exhausted failures, missing configuration, repeated memory deferrals, or
  any OOM/restart requires inspection; do not auto-increase memory/concurrency.

These are operating targets, not established latency guarantees. Estimate capacity
from measured per-action service times and arrival rates, including retries;
one worker cannot drain faster than its serial work time permits. Do not promise
instant completion or scale based only on queue count.

## Rollback without data loss

1. Stop new queue claims, abort/drain the active action and decoder, and verify no
   old process can publish. Honor queue and image-stage lease expiry when uncertain.
2. Switch to the previous queue-aware release/mode with EC2 cron processing restored.
   Re-enable provider sweeps only after the queue consumer is stopped. Keep trigger
   capture in shadow if healthy; disable those triggers specifically if they are
   causing source-write failures, relying on reconciliation during the rollback.
3. Retain work rows, image columns, completed results, originals and R2 variants.
   Pending explicit JPEG requests remain pending/paused; cron mode does not process
   them automatically. Do not drop the private schema or reset attempt counters.
4. On resuming queue mode, revalidate current domain state, acknowledge already-ready
   work, and repair dependent requests before enabling fresh provider processing.

No backend deployment needs to recreate its retired sweep endpoints. The rollback
execution owner remains the enricher EC2.

## Decisions deliberately left for measured implementation

- Confirm hosted grants and the production backup path for the available PGMQ
  version before production DDL. PGMQ is preferred; do not operate both engines.
- Finalize minimal persisted retry accounting where existing domain stages do
  not have it, including JPEG and unknown outcomes; deliveries are not attempts.
- Choose the actual poll/backfill rate and whether unusually large media arrays
  justify a small planner cursor from observed workload and DB query plans.
- Decide whether to enable automatic new-image JPEG after the core queue is stable.
- Source-scoped geocode retries and policy-version reprocessing are separate changes.

The local implementation is described in QUEUE_SETUP.md. Production producers
and consumers still follow the deployment and observation gates above.
