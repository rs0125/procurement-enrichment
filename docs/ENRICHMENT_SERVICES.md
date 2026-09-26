# Warehouse enrichment services

This is the service layer for the future queue worker. Each action receives one
explicit image or warehouse ID. There is no queue, polling loop, new scheduled
sweep, or automatic chaining between these actions yet.

| Service | Input | Behaviour |
|---|---|---|
| `geocode` | `warehouseId` | Resolve the Google Maps URL only when coordinates are missing. Preserve concurrent coordinate/URL edits. |
| `proximity` | `warehouseId` | Compute missing or coordinate-stale categories using the existing OSM shortlist and Mapbox rules. Preserve current terminal answers and refuse incomplete OSM coverage. |
| `image-label` | `imageId` | Terra scene classification and caption. Document subtype is a separate action. |
| `document-kind` | `imageId` | Terra classification of an already-labelled document as layout, paperwork, etc. |
| `website-approval` | `imageId` | Existing Luna privacy and quality policy. ALLOW, BLOCK and REVIEW are all completed assessments. Existing completed/manual/Sol-reviewed decisions are preserved. |
| `webp` | `imageId` | 1280 px longest edge, quality 75. Reuse an existing variant through targeted object HEAD requests. |
| `jpeg` | `imageId` | Photos: 1280 px; documents: 1920 px. Quality 82, progressive, 4:2:0. Reuse valid small originals up to 200 KiB at the allowed dimensions. |

An `imageId` is the primary key in `labeled_warehouse_images`, not a warehouse ID.
JPEG requires a completed scene label to choose the document/photo size.

## Calling a service locally

Use Node 22.18 or newer. Configure `.env` using `.env.example`, then:

```bash
npm ci
npm run generate
npm run enrich -- list
npm run enrich -- image-label --image-id=123 --dry-run
npm run enrich -- geocode --warehouse-id=2748 --dry-run
npm run enrich -- jpeg --image-id=123
```

Dry runs only read state. They do not claim jobs, call paid providers, upload
objects, update image columns, or write audit rows. Services require only their
own provider configuration, so geocoding and health checks work without image
provider keys.

The HTTP equivalents are `GET /enrichment` and `POST /enrichment/<service>`.
Both require the same `Authorization: Bearer <CRON_SECRET>` used by the existing
cron endpoint. For example, the JSON body for `POST /enrichment/webp` is:

```json
{"imageId":123,"dryRun":true}
```

Results use `READY`, `SKIPPED`, `DEFERRED`, `PARTIAL`, `FAILED`, `UNSUPPORTED`,
`STALE`, or `DRY_RUN`. `DEFERRED` means the caller should return later; no job is
stored in memory. `STALE` means the result lost its ownership/source check and
was not published. A future queue consumer must inspect the result, not just
the HTTP status. Paid model calls that time out still consume a stage attempt.

## Safety and memory

- Existing per-stage database claims and token/lease fencing protect labels,
  document kinds, website decisions and WebPs. Ready stages are not rerun.
- JPEG writes retain the existing source/classification/result checks and
  preserve every non-JPEG field. JPEG retries will be scheduled by the future
  queue; this service only processes an explicitly requested image.
- Warehouse media and raw image objects are retained. Only the existing
  `photosWebp` compatibility projection is refreshed for affected warehouses.
- One enrichment action executes per process. Overlapping calls return
  `DEFERRED` immediately. Different processes still coordinate image stages
  through their existing database claims.
- Admission checks consider host and cgroup memory. Native encodes run in a
  child with a 64 MiB JS heap, a 256 MiB RSS guard, a 16-megapixel input cap,
  and a 30-second deadline. Downloads are capped at 20 MiB and streamed to disk.
- `ENRICHER_TEMP_DIR` defaults to `/var/tmp/warehouse-enricher`. The service
  rejects RAM-backed buffers and directories with less than 256 MiB free.
- Source images must come from the configured HTTPS R2 origin. Uploads only
  create variant keys and use conditional writes; originals are never replaced.
- HTTP/CLI actions have a 180-second budget. The existing nightly geocode route
  remains separate and unchanged in its scheduling and selection rules.

The deployed systemd override limits the combined HTTP service to 768 MiB
(640 MiB soft limit). The existing `warehouse-geocoder.service` unit name is
retained; the alternative `deploy/warehouse-enricher.service` is not installed.

## Existing production compatibility

The EC2 Name tag is `warehouse-enricher`. The running systemd unit is still
`warehouse-geocoder.service`, with application releases under
`/opt/warehouse-enricher/current`. The original `/opt/warehouse-geocoder-utility`
installation and `/etc/warehouse-geocoder.env` remain for compatibility and
backups. Provider settings are in `/etc/warehouse-enricher.env`. Do not start
both service units on the same port. Successful main CI triggers
[OIDC/SSM deployment](CD.md).

`POST /cron/geocode-recent`, the DuckDNS hostname, the Supabase 02:57 IST job,
and the separate 04:00 IST backup timer remain compatible. No new service is
scheduled and no dashboard/website cron has been cut over in this phase.

The Prisma additions describe existing shared tables only. There is no database
migration in this change. Do not run `prisma db push` against Supabase.

## Module layout and provenance

`src/services/enrichment/` contains one module per action, with a small registry
in `index.mjs`. HTTP and CLI call that registry; a future queue can call it too.
Repositories live under `src/models/images`, `geocode`, and `proximity`.

`src/lib/images` carries the dashboard's tested classification prompts,
website policy/normalization, image contract, cache invalidation and JPEG policy.
`src/lib/proximity` carries the dashboard's category, shortlist and routing logic.
The proximity SQL and computation were ported from the dashboard. Their business
rules are preserved. These are independent local modules, with no runtime
imports from sibling repositories. Keep provider-policy changes coordinated
until the old cron execution is retired.

## Verification

```bash
npm test
```

The PostGIS integration test is opt-in and rejects any database URL outside
localhost or any database name other than `enricher_test`. Use a disposable
database: the test replaces its fixture tables.

```bash
podman run --detach --name warehouse-enricher-test --memory=768m --cpus=1 \
  --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -e POSTGRES_PASSWORD=enricher-local-test -e POSTGRES_DB=enricher_test \
  -p 127.0.0.1:55438:5432 docker.io/postgis/postgis:17-3.5

# Wait until pg_isready succeeds inside the test container.
ENRICHER_TEST_DATABASE_URL=postgresql://postgres:enricher-local-test@127.0.0.1:55438/enricher_test npm test
podman rm -f warehouse-enricher-test
```

Tests cover native output format/dimensions, memory and disk admission, source
size/origin limits, cancellation, cleanup, authentication, independent services,
preservation of completed reviews, exclusive image claims, original preservation,
JPEG publication races and coordinate races. They do not call paid providers or R2.

The next phase is durable queue delivery, retries and producer hooks, followed
by coordinated retirement of the old sweeps. Website rebuild scheduling is also
part of that cutover; this layer only provides the existing cache invalidation.
