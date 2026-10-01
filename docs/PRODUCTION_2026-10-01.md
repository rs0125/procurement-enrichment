# Production release and image-processing recovery: 1 October 2026

## Delivery state

Dashboard revision `acec800b78e105ac4a850c0ce15448247a8a209a` passed CI and
deployed through App Runner. It makes staged warehouse promotion atomic before
queue capture can observe a newly created warehouse.

Enricher revision `c78b89a99c66bfe87f005eae872b5f46b4c32868` passed CI and
deployed through OIDC/SSM to EC2 `i-0c32bf6ffaca045f1`. The installed root release
helper was updated before deploying. The running unit remains
`warehouse-geocoder.service`; its release lives below `/opt/warehouse-enricher`.

Delivery remains `cron`, role `worker`. The authenticated queue status reports
the consumer disabled and zero claimed messages. PGMQ installation, queue SQL,
source capture triggers and queue consumption have not been activated. The
15-minute enrichment cron, nightly geocoder, website build/WebP trigger, CRM
schedules and independent backup timer remain enabled.

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
no skips, and all 19 deployment tests passed. These restore fixes are local at
this checkpoint and still need release; no production service or queue setting
was changed by this rehearsal.

## Next cutover gates

1. Observe useful scheduled processing after this recovery, including nightly
   WebP/geocoding and backup cycles; check backlog age as well as HTTP health.
2. Release the restore-helper fixes verified above. The isolated real-backup
   restore and production-shaped queue round-trip gates are now complete.
3. Apply the reviewed additive bootstrap/capture functions, verify grants, and
   enable shadow capture only after those checks. Preserve `Warehouse.media`.
4. Follow the restricted-subject execution trial and widening procedure in
   [QUEUE_ROLLOUT.md](QUEUE_ROLLOUT.md), retaining the cron recovery paths.

The deployed queue code is not evidence that production queue delivery is on.
