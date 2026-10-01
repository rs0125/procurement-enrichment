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

The real restore rehearsal is still incomplete. Production uses PostgreSQL
17.6 with PostGIS 3.3.7, pg_net 0.20.4, pg_cron 1.6.4, vector 0.8.2 and Supabase
Vault 0.3.1, among other extensions. The ordinary local PostGIS test image does
not provide that full extension set. Pulling the matching Supabase image hit
the workstation's disk limit and was stopped. Do not weaken manifest version
checks or claim the fixture round-trip proves this production restore.

## Next cutover gates

1. Observe useful scheduled processing after this recovery, including nightly
   WebP/geocoding and backup cycles; check backlog age as well as HTTP health.
2. Complete the isolated production-shaped restore with matching extensions and
   enough local disk, without enabling restored cron jobs or external callbacks.
3. Apply the reviewed additive bootstrap/capture functions, verify grants, and
   enable shadow capture only after those checks. Preserve `Warehouse.media`.
4. Follow the restricted-subject execution trial and widening procedure in
   [QUEUE_ROLLOUT.md](QUEUE_ROLLOUT.md), retaining the cron recovery paths.

The deployed queue code is not evidence that production queue delivery is on.
