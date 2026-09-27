# warehouse-enricher

The local service now includes discrete geocoding, proximity, image labeling,
website approval, WebP and JPEG actions. See [Enrichment services](docs/ENRICHMENT_SERVICES.md)
for the API, CLI and memory limits. [Scheduled enrichment](docs/CRON_MIGRATION.md)
ports the existing crons here before introducing queues.

The EC2 display name is `warehouse-enricher`. Existing production unit names,
paths, geocode scheduling and backups are retained. The GitHub
repository is [rs0125/procurement-enrichment](https://github.com/rs0125/procurement-enrichment).
Pushes and pull requests run [CI](docs/CI.md). Successful CI on `main` triggers
[EC2 deployment](docs/CD.md) through OIDC and Systems Manager.

The existing nightly job resolves Google Maps URLs on `Warehouse` rows into latitude/longitude on
`WarehouseData`. Runs as a small Node/Express service on EC2, fired daily by
Supabase `pg_cron` at 02:57 IST.

This repo also owns the daily Postgres `pg_dump` → S3 backup (systemd timer on
the same box) and a handful of one-off scripts for backfilling, retrying, and
diagnosing the long tail of warehouses that didn't geocode cleanly.

---

## The big picture

```
                    ┌────────────────────┐
                    │ Supabase Postgres  │
                    │  pg_cron @ 21:27   │
                    │      UTC daily     │
                    └─────────┬──────────┘
                              │ pg_net.http_post
                              ▼
              https://wareongo-cronjobs.duckdns.org
                              │
                       ┌──────┴──────┐
                       │  Caddy :443 │   (TLS via Let's Encrypt)
                       │  on EC2     │
                       └──────┬──────┘
                              │ reverse-proxy
                              ▼
              ┌───────────────────────────────────┐
              │ Node/Express   (this repo)        │
              │ /cron/geocode-recent  → service   │
              │ /health               → DB ping   │
              └───────┬───────────────────────────┘
                      │ Prisma
                      ▼
              ┌────────────────┐        ┌────────────────────────┐
              │ Warehouse      │        │ GeocodeAttempt  audit  │
              │ WarehouseData  │◀──────▶│ CronRunLog      audit  │
              └────────────────┘        └────────────────────────┘

   (Same EC2 box, separately)
   systemd timer 22:30 UTC → backup.sh → pg_dump → S3
```

- The existing geocoder handles recent inflow. `/cron/enrichment` and `/cron/webp`
  run bounded batches of the separately callable enrichment actions.
- The DB backup is **not** triggered over HTTP — it's a systemd timer on the
  same box. The two jobs share the EC2 host and the `CronRunLog` audit table
  but nothing else.
- Bulk geocoding uses [scripts/geocode-all.mjs](scripts/geocode-all.mjs).

---

## Prerequisites

- **Node 22.18 or newer**. CI uses Node 22.21.1 and the runtime uses
  `--experimental-strip-types` for the generated Prisma client.
- Access to the Supabase project that owns `Warehouse` / `WarehouseData`.
- For deploy / ops tasks: AWS CLI with credentials for account `111206816712`
  (`ap-south-1`), plus the SSH key at `~/.ssh/warehouse-geocoder-key.pem`.

---

## Setup

```bash
git clone https://github.com/rs0125/procurement-enrichment.git warehouse-enricher
cd warehouse-enricher
npm ci
npm run generate
```

Create `.env` in the repo root:

```dotenv
DATABASE_URL=postgresql://...      # Supabase session-mode pooler, port 5432
CRON_SECRET=<openssl rand -hex 32> # bearer token for /cron/* routes
PORT=3000                          # optional, defaults to 3000
```

The session-mode pooler is required: `pg_dump` and Prisma migrations break on
the transaction pooler (port 6543). See `deploy/DB_BACKUP.md:50-59`.

`.env` is gitignored. So is `sql/` — the live pg_cron setup file inlines a
bearer token and must not be committed.

---

## Running locally

```bash
npm run dev      # nodemon, restarts on change
npm start        # plain node, what production runs

# Smoke test
curl http://localhost:3000/health
# → {"status":"ok","db":"connected"}

# Trigger the cron locally (replace TOKEN with $CRON_SECRET)
curl -X POST http://localhost:3000/cron/geocode-recent \
  -H "Authorization: Bearer $TOKEN"
```

The cron handler pages through warehouses created in the last 7 days that
still lack lat/lng, paces requests at 2s, and writes a summary row to
`CronRunLog`. Full contract: [docs/HTTP_API.md](./docs/HTTP_API.md).

---

## Repo layout

```
src/
├── index.mjs                  entry: start server, install shutdown hooks
├── app.mjs                    build the Express app (no .listen)
├── config/
│   ├── env.mjs                read + validate env vars
│   └── prisma.mjs             singleton PrismaClient + pg pool
├── middlewares/
│   ├── requireCronAuth.mjs    Authorization: Bearer $CRON_SECRET
│   └── errorHandler.mjs       central 500 handler
├── routes/
│   ├── index.mjs              mounts /health, /cron
│   └── cron.routes.mjs        POST /cron/geocode-recent
├── controllers/cron/          HTTP layer (thin)
├── services/cron/             business logic
├── models/                    Prisma-backed repositories
│   ├── cron/runLogRepo.mjs
│   └── geocode/{attemptRepo,warehouseDataRepo}.mjs
└── lib/googleMaps/            scraping primitives
    ├── session.mjs            warm-up + browser headers
    └── extractor.mjs          URL/CID coord extraction

scripts/                       enrichment CLI and bulk geocoding
prisma/schema.prisma           full DB schema (many tables not owned by this service)
sql/001_add_geocode_audit.sql  the only migration this repo owns
sql/pg_cron_setup.sql          (gitignored) live pg_cron config on Supabase
deploy/                        EC2 + backup deployment specs
docs/                          design docs and HTTP API reference
```

The architecture follows the conventions in
[`docs/geocode-cron-spec.md`](./docs/geocode-cron-spec.md): feature-grouped
MVC, repositories on top of Prisma, `lib/` for external-service clients.
**A second cron job adds files, not lines.**

---

## Document map

| Document | What it covers |
|---|---|
| [docs/HTTP_API.md](./docs/HTTP_API.md) | Endpoints, auth, request/response shapes |
| [docs/geocode-cron-spec.md](./docs/geocode-cron-spec.md) | Original design doc for the geocode cron (still authoritative for the data model and audit logic) |
| [docs/ENRICHMENT_SERVICES.md](docs/ENRICHMENT_SERVICES.md) | The seven enrichment actions, API/CLI and local tests |
| [docs/CI.md](docs/CI.md) | GitHub Actions verification and the separate deployment phase |
| [docs/CD.md](docs/CD.md) | Current EC2 release flow, authentication and rollback |
| [deploy/AWS_DEPLOYMENT.md](./deploy/AWS_DEPLOYMENT.md) | Live EC2 resources, bootstrap, day-to-day ops |
| [deploy/DB_BACKUP.md](./deploy/DB_BACKUP.md) | systemd-timed nightly `pg_dump` → S3 |
| [deploy/README.md](./deploy/README.md) | Older bootstrap notes — `AWS_DEPLOYMENT.md` is the current truth |
| [sql/pg_cron_setup.sql](./sql/pg_cron_setup.sql) | (gitignored) the actual SQL pasted into the Supabase editor |
| [CLAUDE.md](./CLAUDE.md) | Quick orientation for future Claude Code sessions |

---

## Day-to-day operations

The full ops runbook is in [`deploy/AWS_DEPLOYMENT.md:185`](./deploy/AWS_DEPLOYMENT.md).
The short version:

```bash
# All commands assume the key at ~/.ssh/warehouse-geocoder-key.pem
HOST=15.206.183.233
SSH="ssh -i ~/.ssh/warehouse-geocoder-key.pem ubuntu@$HOST"

$SSH 'journalctl -u warehouse-geocoder -f'            # tail app logs
$SSH 'journalctl -u warehouse-geocoder-backup -e'     # last backup run
$SSH 'sudo systemctl restart warehouse-geocoder'      # restart app
```

Pushes to `main` run `.github/workflows/ci.yml`, followed by the deployment
workflow when CI succeeds. See [the current deployment runbook](docs/CD.md).
The previous SSH-pull-restart workflow remains archived at
`deploy/legacy-deploy.yml.example`.

---

## Three places to look when something feels wrong

1. **`CronRunLog`** — one row per cron tick, per job. `jobName = 'geocode-recent'`
   or `'backup-db'`. `status`, `durationMs`, and a `metadata` JSON blob with
   per-job counters.
2. **Supabase `cron.job_run_details`** — did `pg_cron` actually fire?
3. **Supabase `net._http_response`** — what the EC2 endpoint returned for
   each tick (full response body, status code).

See [`docs/geocode-cron-spec.md:281-310`](./docs/geocode-cron-spec.md) for
ready-made diagnostic queries.

---

## Gotchas

- **Supabase `pg_net` only allows outbound to ports 80/443.** That's why
  Caddy fronts the Node app on `:443` and reverse-proxies to `localhost:3000`
  — pg_net cannot reach `:3000` directly. Documented in
  [`sql/pg_cron_setup.sql:12-14`](./sql/pg_cron_setup.sql).
- **DuckDNS hostname re-publishes the public IP every 5 min** so the cron
  target survives EC2 stop/start. Hostname is `wareongo-cronjobs.duckdns.org`.
- **The pg_cron bearer secret lives inline in `cron.job`.** Anyone with read
  on the `cron` schema in Supabase sees it. Rotate `CRON_SECRET` if access
  changes — both on the EC2 (`/etc/warehouse-geocoder.env`) and in the
  scheduled SQL.
- **Prisma uses the experimental TypeScript-stripping mode** (`node
  --experimental-strip-types`) to import the generated client directly from
  `.ts`. Don't switch to plain `node`; it won't load the generated client.
- **The `output/` directory is local-only** (gitignored) — it's the working
  area for the offline scripts. Don't expect it to exist on the EC2 box.
