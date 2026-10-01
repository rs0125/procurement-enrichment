# Production release and image-processing recovery: 1 October 2026

## Delivery state

Dashboard revision `acec800b78e105ac4a850c0ce15448247a8a209a` passed CI and
deployed through App Runner. It makes staged warehouse promotion atomic before
queue capture can observe a newly created warehouse.

The image recovery used enricher revision `c78b89a99c66bfe87f005eae872b5f46b4c32868`, which passed CI and
deployed through OIDC/SSM to EC2 `i-0c32bf6ffaca045f1`. The installed root release
helper was updated before deploying. The running unit remains
`warehouse-geocoder.service`; its release lives below `/opt/warehouse-enricher`.

The subsequent release `fe6a8e9e7e9ac97969a1e1a56b6c4f416784afec` deployed the
restore fixes. **Delivery is now `queue`, role `worker`, with no trial restriction**
(20:23 UTC on 1 October; 01:53 IST on 2 October). PGMQ, private grants and source
capture are active. The 15-minute enrichment cron, nightly geocoder, website
build/WebP trigger, CRM schedules and independent backup timer remain enabled.
Enrichment crons reconcile/enqueue; one queue consumer executes the actions.
See [queue activation](#queue-activation) for the live evidence and remaining checks.

## Image incident and recovery

The previous process reached approximately 390 MiB RSS, above the 384 MiB
admission ceiling. It kept returning `DEFERRED / memory_pressure` without
recovering. Scheduled requests were arriving, but labels and website privacy
reviews stopped progressing. There were no observed OOM kills.

For example, warehouse 2835 had eight intact originals and eight registered
images, but initially had no labels, website decisions or WebPs. The API
correctly excluded unreviewed images. Original-image fallback is only available
after approval; it must never bypass contact-board, phone-number or document
exclusions. Static pages built during the backlog retained their empty galleries
until rebuilt.

The worker was restarted and existing actions processed the backlog serially,
without resetting attempts or overriding decisions. The recovery WebP runs
completed 255 then 24 variants; the latter reported SUCCESS and no remaining
WebP backlog at that observation. Both the API and rebuilt public page for
2835 return a five-image gallery selected from eight approved images. Before
compression caught up, the API served the five approved originals. Afterward,
the live page's displayed WebP returned HTTP 200 and rendered in a clean browser.

The recovery fix retains memory and concurrency limits. When admission finds
the idle process itself above its RSS limit, it requests graceful shutdown once,
stops new admission, drains work, and exits unsuccessfully for systemd to restart.
External memory pressure alone still defers without a restart loop. Busy work
is not interrupted by another admission request. Regression coverage verifies
that recycling happens before claiming a queue receipt or starting a provider.
All 132 JavaScript tests passed, including the isolated database/queue tests;
CI and deployment health checks also passed.

Some recent empty galleries are intentional: 2840, 2841, 2842, 2844 and 2850
had only document-classified media, and 2843/2847 had no source images. Do not
treat these cases as permission to expose documents or unapproved originals.

## Backup verification

Both backup units now run as `warehouse-enricher-backup`, with no capabilities,
`NoNewPrivileges=yes`, `ProtectSystem=strict` and a 384 MiB cgroup limit. The
daily timer remains active. An on-demand production backup at 12:07 UTC
completed in approximately 18 seconds and uploaded a 26,931,200-byte
`wareongo-postgres-queue-v1` bundle containing `public` and `panos`. Its manifest
and domain-dump checksum were inspected after download into a private directory.
There were no queues installed to export yet.

After disk space was freed, the production-shaped restore rehearsal passed
using `supabase/postgres:17.6.1.178`, PostgreSQL 17.6 and all nine exact manifest
extension versions. The image digest used was
`sha256:49c938c7918f1543618b60568f5a995e52d98f19883075a14f89643e8b1571fe`.
The source and recovery containers had networking disabled, private Unix
sockets, disabled cron execution, a 768 MiB memory limit and one CPU each.
The required RLS role identities were created with no login access; see
[QUEUE_BACKUP.md](QUEUE_BACKUP.md) for the prerequisites.

The real bundle restored in 21.6 seconds. Independent data extraction compared
per-table counts and order-independent SHA-256 row digests: all 365,077 backed-up
rows across 53 table-data sections matched, as did all 20 exported sequence
values. This includes 2,694 warehouse rows with their original `media` and
17,285 image rows. The extension-managed baseline is supplied by the exact
extension versions; this result does not certify R2 bytes, authentication data
or production login credentials omitted from the bundle.

An additional queue round-trip on the isolated production-shaped database
passed in 25.6 seconds. It preserved four pending jobs (including one claimed
job with its read count and visibility timestamp), two archived jobs and one
dead letter. Checks confirmed transactional source capture/rollback, ignored
no-op updates, a consistent domain/queue snapshot boundary, sequence allocation
without reusing later IDs, refusal to overwrite a nonempty destination, and
no invalid indexes. Public web roles could not use the private wrappers. After
reinstalling the documented grants, the restricted worker passed queue doctor
and remained unable to read raw queue tables.

The rehearsal found and locally fixed two restore-helper defects: attempting
`CREATE SCHEMA IF NOT EXISTS pg_catalog`, and treating the successful early
input close from `pg_restore --list` as an archive failure. The latter exception
is limited to catalog listing and still requires exit status zero; data restore
and COPY streams retain strict failure handling. Both have regression coverage.
With the locked Prisma 7.10.0 dependencies, all 133 JavaScript tests passed with
no skips, and all 19 deployment tests passed. The fixes were subsequently
committed without coauthors and deployed as `fe6a8e9`. CI and EC2 CD passed; the
installed backup helper matches the release source.

## Queue activation

All timestamps in this section are UTC, 1 October 2026.

- **17:17:** took a fresh backup, then installed reviewed additive migrations
  `001_bootstrap.sql` and `002_capture_functions.sql`. PGMQ is 1.5.1 and the
  contract is `pgmq-1.5.1-actions-v2`. Both ordinary durable queues exist.
  Doctor passed; anonymous/authenticated web roles cannot access private queue
  functions or tables. Warehouse count and original media/legacy photos matched.
- **17:57:** enabled both source triggers using `003_enable_capture.sql`, with
  the worker in shadow mode and crons still executing inline.
- **18:11:** a controlled transaction on 2835 changed then restored source values
  before commit. Full row hashes matched. Rollback discarded four events; commit
  retained four events; a no-op update added none. No external reader could see
  temporary values. Warm transaction time was 74 ms, with a 0.633 ms Warehouse
  trigger call; this is one supervised probe, not a fleet latency benchmark.
- **18:20:** a live queue-aware backup succeeded: 27,013,120 bytes, with `public`,
  `panos`, private `enrichment`, and both `enrichment_jobs`/`enrichment_dead` queues.
  The independent backup timer remains active.
- **19:26:** the restricted real execution trial passed, supervised by a
  12-minute automatic rollback timer. Five warehouse IDs and 17 image IDs were
  allowed. It returned to shadow and stopped the timer after verification.
- **20:23:** drained inline work and enabled normal queue consumption without an
  allowlist. Health, leadership and queue doctor passed. Existing schedules were
  retained; no source column or original storage object was removed.
- **20:30:** verified an unrestricted worker, zero errors/dead letters/runnable
  backlog, and successful enrichment reconciliation. Nightly WebP maintenance
  had started; its acceptance was not yet evidence of completion.
- **20:41:** confirmed nightly WebP maintenance completed successfully: 17,259
  active WebP rows READY, no remaining work, no failures or deferrals. The queue
  remained healthy with only the two geocoder cooldown jobs pending.

The trial covered a permitted indoor image, permitted T3 outdoor image, blocked
document, and blocked contact-board photo. Twenty selected image deliveries
completed, plus refresh/follow-up and duplicate checks. JPEG results were:

| Registry ID | Output | Bytes | Verified dimensions |
|---|---|---:|---|
| 9488995 | Photo JPEG policy, 1280 px maximum | 36,895 | 448 × 691 |
| 9488996 | Photo JPEG policy, 1280 px maximum | 41,656 | 456 × 619 |
| 11097881 | Document JPEG policy, 1920 px maximum | 98,097 | 1446 × 1190 |
| 11321937 | Suitable small original JPEG reused | 171,138 | 1280 × 960 |

All URLs returned HTTP 200; downloaded byte counts and decoded JPEG metadata
matched. No image was upscaled. Each requested JPEG had one successful guarded
attempt, and a duplicate reused its result. Every non-JPEG image field matched
the baseline, including captions, labels, decisions, WebPs and attempt counts.
Original media/source links matched, and non-trial image attempts did not change.
An excluded warehouse refresh deferred without processing and completed after
the restriction was removed. This deployment did not generate a fleet JPEG backfill.

Geocoder IDs 2803/2824 were processed by the existing cron at 18:20 and both
returned `no_match`, leaving missing coordinates and attempt count 2. The trial
proved queue deliveries respect their 24-hour cooldown without another attempt.
At 20:30 these were the only two pending jobs, invisible until their next eligible
time on 2 October. Their unresolved source locations are separate from queue
delivery health; no attempt count was reset to force a success.

Trial peak cgroup memory was 180,744,192 bytes (about 172 MiB), with no unexpected
restarts, queue errors or dead letters. The service retains its 256 MiB Node heap,
640 MiB soft/768 MiB hard cap, one-action admission and isolated decoder limits.
Those bounds are not a guarantee that OOM is impossible under every workload.

## Remaining observation and rollback

The original target of two extra healthy cron-only nights after memory recovery
was not completed. Activation followed the supervised real-work/capture/reuse/
privacy/cooldown/backup checks above. Observe two full nights under queue ownership
before reducing reconciliation or removing inline rollback handlers. Include
actual new-media progression, WebP inventory/projection completion, website build,
geocoder eligibility, backup, runnable age, provider errors and memory/restarts.
An empty successful reconciliation does not certify future provider throughput.

To roll back processing, preserve the root-only environment files and switch
`ENRICHMENT_DELIVERY_MODE` to `shadow`, role `worker`, removing any trial setting;
restart gracefully under the deployment lock. This stops queue claims and restores
inline cron processing while retaining captured work. Do not clear queues or reset
domain attempts. `004_disable_capture.sql` only detaches source triggers and is
not a consumer stop command. Keep queue-aware backups during rollback.

No new Supabase, AWS, model-provider or R2 credential was required. Existing secrets
remain in root-owned environment files; none are part of the documentation or commit.
