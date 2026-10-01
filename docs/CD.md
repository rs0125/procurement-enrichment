# EC2 deployment

The service runs on `i-0c32bf6ffaca045f1` in `ap-south-1`. The EC2 display name
is `warehouse-enricher`; the existing systemd unit remains
`warehouse-geocoder.service` so the geocoder's callers and schedules remain valid.

## Release flow

1. Push to `main`, or manually run the CI workflow on `main`.
2. CI verifies the lockfile install, Prisma, all JavaScript tests and the
   deployment tests. A successful same-repository push/manual CI run triggers
   `.github/workflows/deploy.yml`. Pull request runs cannot deploy.
3. GitHub's `production` environment allows only `main`. OIDC exchanges the
   job identity for a short-lived AWS role; no AWS keys or SSH private key are
   stored in GitHub.
4. The role can invoke only version 1 of `WarehouseEnricher-Deploy` against this
   instance and read command results. It cannot submit arbitrary shell commands,
   edit IAM or SSM documents, read application secrets, or read the backup bucket.
5. The installed, root-owned `/usr/local/sbin/warehouse-enricher-deploy` validates
   the full commit SHA against the current remote `main`, builds a separate
   release, and runs all local application tests on ARM. Database fault tests
   run against disposable PostGIS in CI; they never use the production database.
6. A temporary service on port 3001 checks database health, authentication and
   the enrichment catalog. It does not run a geocode sweep or other live actions.
7. The helper changes `current`, restarts the existing unit and verifies the
   running process and health. Failed promotion restores the previous release
   and unit configuration. Completed older releases are pruned while retaining
   the current, previous and three newest releases.

Production deployments are serialized and are not cancelled by another push.
The host also takes a deployment lock. A commit superseded on `main` is rejected;
the successful CI run for the new commit will deploy it.

The helper refuses new deployments from **21:15 to 22:45 UTC** (02:45–04:15 IST)
to protect the existing geocoder and backup window. Rerun CI on `main` after
the window if a deployment was deferred.

## Host layout and configuration

| Path | Purpose |
|---|---|
| `/opt/warehouse-enricher/releases/<sha>` | Built release, owned by root |
| `/opt/warehouse-enricher/current` | Active application release |
| `/opt/warehouse-enricher/previous` | Previous release for rollback |
| `/etc/systemd/system/warehouse-geocoder.service.d/enricher-release.conf` | Release directory and resource limits |
| `/etc/warehouse-geocoder.env` | Existing database, cron and backup configuration; retained unchanged |
| `/etc/warehouse-enricher.env` | Provider configuration, root-owned mode 0600 |
| `/var/lib/warehouse-enricher/buffers` | Disk-backed image buffers, owned by the runtime account |
| `/opt/warehouse-geocoder-utility` | Original installation, retained for backup scripts and initial rollback |

The provider file contains only the OpenAI, Mapbox and R2 settings needed by
the explicit actions, plus optional cache invalidation configuration. Do not put
application credentials into workflows, repository variables, source archives
or build logs. Edit provider settings on the host with `sudoedit` and restart
the application when changing them.

Build commands run as the non-login `warehouse-enricher-build` account in a
transient systemd service, with a clean environment and a dummy database URL.
The service disables privilege escalation and capabilities, protects home and
system directories, and permits persistent writes only to the isolated build
and npm cache directories. Each command retains the 640 MiB, 128-task, one-CPU
and runtime limits.

The application and health-only canary run as the separate non-login
`warehouse-enricher` account. They cannot use sudo, gain privileges, write the
release/configuration directories or read user homes. Systemd provides their
writable state directory; temporary files are private. Both units have an empty
capability set, and deployment verifies the effective isolation before accepting
a release. The canary retains its 384 MiB cap. The previous image buffer path is
left untouched so rollback remains possible. The local queue update moves the
backup and failure logger to `warehouse-enricher-backup`, with no capabilities
and a 384 MiB hard memory cap. The separately installed privileged helper owns
and verifies this policy before installing backup code. Older application
releases retain the queue-capable helper; see [queue backups](QUEUE_BACKUP.md).
This backup isolation change still requires installation and verification on EC2.

Changes to the installed deployment helper require administrative installation
before pushing a release that depends on them. Application pushes do not replace
the helper. Production environment files stay root-owned and are loaded by
systemd at runtime. Workflow logs show status and revision only; detailed command
errors remain in the root-only host log.

The application has a 768 MiB systemd memory limit, a 640 MiB soft limit, and a
256 MiB Node heap. Enrichment and WebP crons are described in `CRON_MIGRATION.md`;
production stays in cron mode until the [queue rollout gates](QUEUE_ROLLOUT.md)
pass. The canary explicitly uses the API-only role and cannot consume jobs.
Geocoding remains at **02:57 IST** and the backup timer remains at **04:00 IST**.

## Deployment control files

`deploy/aws/` records the narrow AWS trust, role and agent policies and the
fixed SSM document. The trust subject uses this repository's immutable owner
and repository IDs and the `production` environment. Repository or environment
renames require updating that exact trust condition.

The repository helper is `deploy/ec2-release.py`; local queue changes have not
yet updated the installed copy. Changes to that privileged
helper require a reviewed administrative installation; application releases do
not replace it automatically. The SSM document pins the fixed helper path and
accepts only a 40-character lowercase commit SHA. Agent permissions were added
to the existing instance role without changing its backup permissions.

## Manual deployment and verification

From an authenticated SSH session on the instance:

```bash
sudo /usr/local/sbin/warehouse-enricher-deploy <full-current-main-sha>
curl --fail --silent http://127.0.0.1:3000/health
sudo systemctl is-active warehouse-geocoder.service
sudo systemctl is-active warehouse-geocoder-backup.timer
readlink -f /opt/warehouse-enricher/current
```

The first manual release was `f27568bcaf11891025e491c7b505f2c6065a5bd5`.
Native encoder/service tests, authenticated dry runs of all seven actions,
public HTTPS health, and the unchanged geocoding/backup configuration were
verified before CD was enabled. Dry runs do not establish paid-provider output
quality or production queue throughput; those belong to the next phase.

For an incident, inspect the private host logs through an administrative session;
do not paste complete environment files or logs into GitHub. A failed promotion
restores the previous release automatically. The original installation and
backup files are retained independently of release cleanup.
