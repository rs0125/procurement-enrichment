# Continuous integration

The GitHub repository is [rs0125/procurement-enrichment](https://github.com/rs0125/procurement-enrichment).
The application and local checkout are named `warehouse-enricher`.

`.github/workflows/ci.yml` runs on pushes to `main`, pull requests targeting
`main`, and manual dispatch. It uses Node 22.21.1 on Ubuntu 24.04 with an
isolated PostgreSQL 17/PostGIS 3.5 service container.

The job installs dependencies from the lockfile, validates the Prisma schema,
generates the Prisma client, checks CLI service registration, and runs all
unit, HTTP, native image encoder and database integration tests. The test
database URL is supplied explicitly so the database tests run in CI.

Only disposable test credentials are configured. No GitHub secrets are needed;
CI does not contact Supabase, paid providers, R2 or EC2. Tests cover database
ownership and publication races as well as actual JPEG/WebP output. They do
not establish live provider compatibility or production load capacity.

## Running the same checks locally

Use Node 22.21.1 and a disposable PostGIS database named `enricher_test` on
localhost. See [Enrichment services](ENRICHMENT_SERVICES.md#verification) for
the Podman command. Database tests replace their fixture tables.

```bash
export DATABASE_URL=postgresql://postgres:enricher-local-test@127.0.0.1:55438/enricher_test
export ENRICHER_TEST_DATABASE_URL="$DATABASE_URL"
export CRON_SECRET=ci-only-test-secret
export NODE_ENV=test
npm ci --no-audit --no-fund
npx prisma validate
npm run generate
npm run enrich -- list
npm test
```

## Deployment remains separate

There is currently no active deployment workflow. The former push-to-EC2
workflow is archived at `deploy/legacy-deploy.yml.example`, outside GitHub's
workflow directory. It is reference material, not a deployment-ready template.

An EC2 deployment workflow will follow live testing of the enrichment services.
That work must account for the existing geocoder and backup schedules, install
the required configuration, and verify health and rollback. Pushing this
repository does not change the running EC2 service.
