# warehouse-enricher

WareOnGo's background enrichment service for warehouse inventory: coordinates,
nearby landmarks, image labels/captions, website suitability and compressed WebP
and JPEG variants. It shares Supabase and R2 with the dashboard and website.
Original media is retained; consumers select appropriate variants and fallbacks.

Start with **[Service architecture and enterprise context](docs/ARCHITECTURE.md)**
for ownership, integrations, data flows, schedules and the future queue boundary.

The proposed queue migration is documented in
[Queue architecture](docs/QUEUE_ARCHITECTURE.md),
[work and delivery contract](docs/QUEUE_CONTRACT.md), and
[rollout and verification](docs/QUEUE_ROLLOUT.md). The
[local PGMQ evaluation](docs/PGMQ_EVALUATION.md) now recommends Supabase Queues
with our existing action guards. The [queue integration and setup runbook](docs/QUEUE_SETUP.md) covers the seven
guarded action adapters, worker lifecycle, paged registration, atomic dashboard
approval, and consistent backups. These changes are local; production still uses
the crons below. Production SQL, deployment, shadow observation and cutover remain.

The production EC2 display name is `warehouse-enricher`; the retained systemd
unit is `warehouse-geocoder.service`. The original geocoder now uses the same
bounded action layer as image/proximity enrichment. A separate systemd timer
on this host runs the database backup. Queue consumption is disabled by default.

## Actions and schedules

| Action | Result |
|---|---|
| `geocode` | Missing warehouse coordinates from a Google Maps URL |
| `proximity` | Nearby landmark answers from OSM/PostGIS and Mapbox |
| `image-label` | Terra scene classification and caption |
| `document-kind` | Separate document subtype classification |
| `website-approval` | Luna privacy decision and quality assessment |
| `webp` | Website variant, 1280 px longest edge / quality 75 |
| `jpeg` | PPT variant, 1280 px photos / 1920 px documents / quality 82 |

The 15-minute enrichment cron runs labels, document kinds, website approval and
proximity. WebP runs through the nightly CMS/website maintenance trigger at
02:00 IST; geocoding runs at 02:57 IST. JPEG remains an explicit action. The
separate database backup runs at 04:00 IST. See [scheduled work](docs/CRON_MIGRATION.md)
for count/time budgets and the stability gate before queues.

## Local setup

Use Node **22.18 or newer**; CI pins Node 22.21.1. The generated Prisma client
requires the `--experimental-strip-types` flag already present in npm scripts.

```bash
git clone https://github.com/rs0125/procurement-enrichment.git warehouse-enricher
cd warehouse-enricher
cp .env.example .env
# Configure a development database, CRON_SECRET and required provider settings.
npm ci
npm run generate
npm run enrich -- list
npm run dev
```

Use the Supabase session-mode pooler on port 5432 for deployed database access.
Keep `.env` local. OpenAI, Mapbox and R2 settings are required only by their
corresponding actions; see [the environment template](.env.example).
Do not run `prisma db push` against the shared production database.

```bash
curl --fail --silent http://localhost:3000/health
npm run enrich -- image-label --image-id=123 --dry-run
npm run enrich -- geocode --warehouse-id=2748 --dry-run
```

An `imageId` identifies a row in `labeled_warehouse_images`, not a warehouse.
Dry runs inspect state without model calls, uploads or writes. Explicit actions
also have authenticated HTTP endpoints; see [actions](docs/ENRICHMENT_SERVICES.md)
and [HTTP contracts](docs/HTTP_API.md). Cron POSTs acknowledge accepted work with
202; inspect their GET status to determine completion.

## Verification and deployment

`npm test` runs the JavaScript suite. The complete CI suite also uses a disposable
PostGIS database and Python deployment tests. See [local test setup](docs/ENRICHMENT_SERVICES.md#verification)
and [CI](docs/CI.md); fixture tests must never use production data.

Pushes to `main` run CI, then [EC2 deployment](docs/CD.md) through GitHub OIDC and
Systems Manager. The release helper builds/tests on ARM, runs a health-only
canary, switches the release and verifies it, with rollback on failed promotion.
No long-lived AWS or SSH credential is stored in GitHub. Deployments are deferred
during the geocoder/backup window, 21:15–22:45 UTC.

## Repository guide

| Path | Purpose |
|---|---|
| `src/routes/`, `src/controllers/` | HTTP authentication and handlers |
| `src/services/enrichment/` | Seven independently callable actions |
| `src/services/cron/` | Scheduled batches and run lifecycle |
| `src/models/` | Database repositories, claims and guarded publication |
| `src/lib/` | Provider clients, image/proximity policy and runtime bounds |
| `scripts/enrich.mjs` | Action CLI |
| `scripts/queue.mjs`, `sql/queue/` | Local queue diagnostics/preview and separately applied setup |
| `scripts/geocode-all.mjs` | Separate legacy bulk geocoding tool |
| `prisma/schema.prisma` | Shared schema, including tables owned by other services |
| `tests/` | Application, database, native encoder and deployment checks |
| `deploy/` | EC2 releases, AWS policies, systemd and database backup |

## Documentation

| Document | Use it for |
|---|---|
| [Architecture and enterprise context](docs/ARCHITECTURE.md) | Responsibilities, relationships, data ownership and end-to-end flows |
| [Queue architecture](docs/QUEUE_ARCHITECTURE.md) | Proposed PGMQ delivery, dependencies, producer boundary and EC2 resource model |
| [PGMQ evaluation](docs/PGMQ_EVALUATION.md) | Version checks, local fault tests, acknowledgement and backup requirements |
| [Queue integration and setup](docs/QUEUE_SETUP.md) | Integrated actions, modes, SQL setup, existing credentials and deployment gates |
| [Queue contract](docs/QUEUE_CONTRACT.md) | Proposed work identity, claims, retries, source fencing and failure recovery |
| [Queue rollout](docs/QUEUE_ROLLOUT.md) | Implementation phases, canary/backup changes, acceptance tests and rollback |
| [Queue adversarial review](docs/QUEUE_ADVERSARIAL_REVIEW.md) | Reproduced faults, local fixes, tests and remaining rollout gates |
| [Enrichment services](docs/ENRICHMENT_SERVICES.md) | Actions, CLI, memory controls and local tests |
| [Scheduled enrichment](docs/CRON_MIGRATION.md) | Triggers, batch bounds, handoff and queue stability gate |
| [HTTP API](docs/HTTP_API.md) | Geocoder endpoint behaviour and links to other contracts |
| [CI](docs/CI.md) / [CD](docs/CD.md) | Verification, release flow, credentials and rollback |
| [AWS host runbook](deploy/AWS_DEPLOYMENT.md) | Host resources and administrative operations; current release flow is in CD |
| [Database backup](deploy/DB_BACKUP.md) | Independent `pg_dump` → S3 timer and restore scope |
| [Geocoder design history](docs/geocode-cron-spec.md) | Original design; superseded API/deployment details are historical |
| [CLAUDE.md](CLAUDE.md) | Short orientation for future coding sessions |

For operational diagnosis, check process health, `CronRunLog`, Supabase
`cron.job_run_details` and `net._http_response`, then stage backlog and actual
consumer output. Scheduled SQL and environment files can contain credentials;
do not print or commit them. The gitignored `output/` directory is for local
offline work and is not part of deployment.
