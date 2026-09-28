# CLAUDE.md

Notes for future Claude Code sessions. Start with [README.md](./README.md) for
human-facing orientation and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for
enterprise context, data ownership, consumer fallbacks and the current execution
model. This file is a terse pointer index.

## Enrichment service layer

The project is now `warehouse-enricher`. See `docs/ENRICHMENT_SERVICES.md` and
`src/services/enrichment/index.mjs` for the seven separately callable services.
The cron handoff is documented in `docs/CRON_MIGRATION.md`; there is no durable
queue or producer cutover yet. Existing production unit names and
paths remain compatible. The repository is `rs0125/procurement-enrichment` on
GitHub. Successful main-branch CI triggers OIDC/SSM deployment. See `docs/CD.md`.

## What this repo does

The original jobs on this EC2 box remain in place:

1. **`/cron/geocode-recent`** — Express endpoint, daily 21:27 UTC, triggered by
   Supabase `pg_cron` → `pg_net` → Caddy → Node. Resolves Google Maps URLs on
   recent `Warehouse` rows into lat/lng on `WarehouseData`.
2. **`backup-db`** — systemd timer on the same box, daily 22:30 UTC. `pg_dump`
   → S3 bucket `wareongo-db-backups-111206816712-apsouth1`. NOT pg_cron.

Both write audit rows to `CronRunLog` (`jobName` discriminator).

The migrated 15-minute enrichment sweep and nightly WebP sweep also run here.
See `src/services/cron/index.mjs` and `docs/CRON_MIGRATION.md` for their bounds,
shared locks, endpoints, handoff procedure and stability gate before queues.

## Where to look first

| Question | File |
|---|---|
| What does endpoint X do? | `docs/HTTP_API.md` |
| Enrichment CLI and CI | `docs/ENRICHMENT_SERVICES.md`, `docs/CI.md` |
| Service architecture and enterprise relationships | `docs/ARCHITECTURE.md` |
| Original geocoder design history | `docs/geocode-cron-spec.md` (current API is in `docs/HTTP_API.md`) |
| Live AWS resources / ops commands | `deploy/AWS_DEPLOYMENT.md` |
| Backup spec | `deploy/DB_BACKUP.md` (script lives in `deploy/backup/`) |
| Live pg_cron SQL on Supabase | `sql/pg_cron_setup.sql` (gitignored — has secret) |
| DB schema | `prisma/schema.prisma` |
| The only migration this repo owns | `sql/001_add_geocode_audit.sql` |

Many tables in `schema.prisma` (`Enquiry`, `MessageLog`, `opportunities`,
`audit_logs`, etc.) belong to other services that share the Supabase DB —
the legacy geocoder owns `GeocodeAttempt`, `CronRunLog`, and writes to
`WarehouseData.latitude` / `longitude`. New enrichment actions also write their
designated image and proximity fields, as documented in `docs/ENRICHMENT_SERVICES.md`.

## Conventions

- **MVC, feature-grouped under each layer.** Adding a new cron means new
  files in `controllers/cron/`, `services/cron/`, maybe `models/<feature>/`.
  Existing files don't grow.
- **`lib/` ≠ `services/`.** `lib/googleMaps/` is reusable infrastructure (used
  both by the cron service and could be by future services). Services hold
  workflow.
- **Repositories on top of Prisma.** Services don't call `prisma.X` directly;
  they go through `models/`.
- **Default to no source comments** unless the WHY is non-obvious. The
  existing code follows this.
- **Per-row transactions in the cron loop** — already-processed rows commit
  even if the run dies mid-way; tomorrow's run picks up the rest.

## Gotchas (don't get caught by these)

- **Supabase `pg_net` only allows outbound to 80/443.** That's why Caddy
  fronts the Node app — pg_net cannot reach `:3000` directly.
- **`pg_cron` runs in UTC, no DST.** India doesn't observe DST anyway, so
  `27 21 * * *` → 02:57 IST stable year-round.
- **The bearer secret is visible in `cron.job`** to anyone with read on the
  `cron` schema. Treat it like any DB credential.
- **Backups skip the `auth` schema.** Supabase Auth users won't transfer in
  a restore. The app doesn't use Supabase Auth today.
- **Use the session-mode pooler (port 5432), not transaction (6543)** for
  both Prisma migrations and `pg_dump`.
- **Node 22 + `--experimental-strip-types`** is load-bearing — the generated
  Prisma client is `.ts` and is imported directly.
- **`output/` is local-only**, gitignored. Don't assume it's on EC2.
- **CI runs on push to `main` and pull requests.** `.github/workflows/ci.yml`
  uses a disposable PostGIS database. Successful main CI triggers the OIDC/SSM
  deployment workflow; pull requests do not deploy. The old SSH workflow is
  archived at `deploy/legacy-deploy.yml.example`.

## Things that look like duplication but aren't (yet)

- `scripts/geocode-all.mjs` re-implements the same `extractCoordinatesFromUrl`
  logic that now lives in `src/lib/googleMaps/`. The spec
  (`docs/geocode-cron-spec.md:188`) explicitly defers refactoring the script
  to share the lib code. Don't pre-emptively unify.
- `docs/CD.md` is authoritative for releases, isolation and rollback.
  `deploy/AWS_DEPLOYMENT.md` records host/bootstrap context with Caddy;
  `deploy/README.md` is the older pre-Caddy bootstrap. Do not replace the current
  release flow with an older pull/restart recipe.

## Verifying claims about live state

The harness gives you a Node runtime with Prisma already configured.
Quick-checks against the live DB pattern:

```js
// scripts/_anything.mjs (gitignored prefix _, delete after use)
import { prisma, disconnect } from "../src/config/prisma.mjs";
const rows = await prisma.cronRunLog.findMany({
  where: { jobName: "backup-db" },
  orderBy: { ranAt: "desc" },
  take: 5,
});
console.log(rows);
await disconnect();
```

Run with `node --experimental-strip-types scripts/_anything.mjs` from the
repo root (must be the repo root — `node_modules` resolution).

For S3 / EC2 / systemd state you need AWS CLI auth (`aws login`) or SSH to
the box. Don't fabricate — say so if you can't reach it.
