# Database backup

The local queue-aware implementation and recovery procedure are documented in
[QUEUE_BACKUP.md](../docs/QUEUE_BACKUP.md). Its new format is one consistent
`.tar` bundle containing the domain dump and PGMQ state. The independent daily
S3 timer, environment and retention remain. Update the installed release helper
and verify non-root backup/failure services plus a new backup/restore before
enabling production queues. The historical bootstrap steps below do not install
the new account or Node modules; use the updated release helper and queue runbook.

The original specification below describes the earlier standalone `.dump` format;
use `pg_restore` directly for those old artifacts, not the new bundle restore CLI.

# Daily Supabase → S3 backup — spec

One `pg_dump` of the Supabase database written to S3 every night, kept for 90
days, with run status recorded in the existing `CronRunLog` table. No external
alerting in v1.

This is the design doc. Implementation lives under `deploy/backup/` (to be
added).

---

## 1. Trigger

systemd timer on the existing EC2 (`i-0c32bf6ffaca045f1`, `ap-south-1`).

- `OnCalendar=*-*-* 22:30:00 UTC` → 04:00 IST. India does not observe DST, so
  this expression is stable year-round.
- `Persistent=true` on the timer.

### "What if the server is down?"

- `Persistent=true` makes systemd record the missed firing and run the unit as
  soon as the box is back up. Short outages (minutes–hours) self-heal — the
  backup just lands late.
- An HTTP-triggered route (Supabase `pg_cron` → `/cron/backup-db`) has the
  **same** failure mode when the box is down (the route can't answer either)
  but **without** catch-up. The trigger fires once and is gone.
- If the EC2 is **terminated** or down for >24h, no on-box scheme survives.
  That case requires an off-box runner (Lambda, GitHub Actions cron, etc.) and
  is out of scope for v1.
- Freshness check (run manually, or via a separate `pg_cron` query — no
  webhook needed since the result lands in the same table):

  ```sql
  select max("ranAt") as last_success
    from "CronRunLog"
   where "jobName" = 'backup-db'
     and status = 'success';
  ```

  Anything older than ~26h means something is wrong.

---

## 2. Dump mechanism

- **Tool:** `pg_dump` from `postgresql-client-<N>` matching the Supabase server
  major version. Check first with `select version();` against the live DB;
  install via the PGDG apt repo on Ubuntu 24.04 arm64. Mismatched major
  versions will refuse to run.
- **Connection:** any Supabase connection that supports `pg_dump` — either
  the direct DB host, or the **session-mode** pooler on port `5432`
  (`aws-0-<region>.pooler.supabase.com:5432`). The **transaction** pooler on
  port `6543` breaks `pg_dump` and must not be used. New env var
  `BACKUP_DATABASE_URL` in `/etc/warehouse-geocoder.env` (mode `600`, owner
  `root`). In the current setup `DATABASE_URL` is already the session pooler
  on `5432`, so `BACKUP_DATABASE_URL` is the same value — it's kept as a
  separate var so future changes to the app's pooling strategy don't
  silently break backups.
- **Format:** `-Fc` (custom, compressed, supports parallel `pg_restore`).
- **Flags:** `--no-owner --no-privileges --verbose`.
- **Scope:** app database only. Use `--schema=public` (add other schemas
  explicitly if/when Prisma starts owning them). Allow-listing rather than
  exclude-listing Supabase-managed schemas is safer — when Supabase adds new
  internal schemas later, we won't accidentally start dumping them.
  - Excluded by virtue of not being listed: `auth`, `storage`, `realtime`,
    `graphql_public`, `supabase_*`, `extensions`, `pgbouncer`, `vault`, `net`,
    `cron`.
  - Consequence: Supabase Auth users are **not** in these dumps. The app
    doesn't use Supabase Auth today; revisit if that changes.
- **Working dir:** `/var/backups/warehouse-geocoder/` on the EC2. Dump →
  upload → delete local file in one script run. The 20 GB root volume is fine
  while dumps stay small (compressed `-Fc` is usually one-to-two orders of
  magnitude smaller than the raw DB), but watch it.

---

## 3. S3 layout

- **Bucket:** `wareongo-db-backups-apsouth1` (or whatever name is available —
  S3 bucket names are global). Same region as EC2 (`ap-south-1`) to avoid
  cross-region egress.
- **Key:**
  `supabase/warehouse-geocoder/YYYY/MM/DD/dump-YYYYMMDDTHHMMSSZ.dump`
- **Bucket settings:**
  - Block Public Access: **all four ON**.
  - Versioning: **ON** (defends against accidental delete/overwrite).
  - Default encryption: **SSE-S3 (AES-256)**. No KMS in v1 — adds cost and
    IAM complexity with no compliance driver today.
  - Object Lock: **off** in v1 (irreversible config; revisit if compliance
    requires WORM).

---

## 4. Retention

S3 Lifecycle rule scoped to prefix `supabase/warehouse-geocoder/`:

| Age | Action |
|---|---|
| 0–30 days | Standard |
| 30–90 days | Glacier Instant Retrieval |
| 90 days+ | Expire current version |
| Noncurrent versions | Expire after 30 days |
| Incomplete multipart uploads | Abort after 7 days |

Stored as `deploy/backup/lifecycle.json` and applied with
`aws s3api put-bucket-lifecycle-configuration`.

---

## 5. IAM

A new **EC2 instance profile role** attached to `i-0c32bf6ffaca045f1`. Do not
reuse the workstation credentials referenced in `AWS_DEPLOYMENT.md`.

Policy actions (scoped to the one bucket + prefix):

- `s3:PutObject`
- `s3:AbortMultipartUpload`
- `s3:ListBucket` (with prefix condition for the backup prefix)

**Not** granted on the EC2:

- `s3:GetObject`, `s3:DeleteObject`, `s3:DeleteObjectVersion` — restores and
  cleanup are workstation-only, audited operations.

The AWS CLI on the box picks up the role via IMDSv2 — no static keys on disk.
Policy lives at `deploy/backup/iam-policy.json`.

---

## 6. Status reporting → `CronRunLog`

The table already exists (`sql/001_add_geocode_audit.sql`). One row per backup
run:

| Column | Value |
|---|---|
| `jobName` | `'backup-db'` |
| `ranAt` | run start time (UTC) |
| `status` | `'success'` or `'failure'` |
| `durationMs` | wall-clock ms from script start to finish |
| `metadata` | `{ "s3Bucket": "...", "s3Key": "...", "bytes": <int>, "schemas": ["public"], "pgServerVersion": "..." }` |
| `notes` | error message on failure; `null` on success |

Logging path: the backup script (bash) writes the row via `psql` against
`DATABASE_URL` (the pooled URL is fine — it's a single `INSERT`) at the end of
its run. On failure, a sister `OnFailure=` unit
(`warehouse-geocoder-backup-failure.service`) inserts the failure row so a
crashed script still produces a `CronRunLog` entry.

Script stdout/stderr also goes to journald — `journalctl -u
warehouse-geocoder-backup` for details on any single run.

---

## 7. File layout (to be added at implementation time)

```
deploy/backup/
├── warehouse-geocoder-backup.service          # oneshot, runs backup.sh
├── warehouse-geocoder-backup.timer            # daily 22:30 UTC, Persistent=true
├── warehouse-geocoder-backup-failure.service  # OnFailure target → logs failure row
├── backup.sh                                  # installed to /usr/local/sbin/
├── log-failure.sh                             # writes the failure row to CronRunLog
├── lifecycle.json                             # S3 lifecycle policy
└── iam-policy.json                            # instance-profile policy
```

---

## 8. Bootstrap (one-shot, from workstation)

1. Create the S3 bucket; apply Block Public Access, versioning, default
   encryption.
2. Apply lifecycle config from `deploy/backup/lifecycle.json`.
3. Create IAM role, attach policy, create instance profile, associate to the
   EC2 instance.
4. SSH to EC2:
   - Install `postgresql-client-<N>` matching server major.
   - Install `backup.sh` to `/usr/local/sbin/warehouse-geocoder-backup`.
   - Drop the three unit files into `/etc/systemd/system/`.
   - `systemctl daemon-reload && systemctl enable --now warehouse-geocoder-backup.timer`.
5. Add `BACKUP_DATABASE_URL` (direct Supabase, port 5432) and `S3_BUCKET`
   (the bucket name created in step 1) to `/etc/warehouse-geocoder.env`.
   Optional overrides: `S3_PREFIX`, `BACKUP_DIR`, `BACKUP_SCHEMAS`
   (comma-separated, defaults to `public`).
6. Manual test: `systemctl start warehouse-geocoder-backup.service`. Verify
   the object lands in S3 and a `success` row appears in `CronRunLog`.

---

## 9. Restore runbook

Restores are manual, deliberate, workstation-only.

1. `aws s3 cp s3://wareongo-db-backups-apsouth1/supabase/warehouse-geocoder/YYYY/MM/DD/dump-….dump ./`
2. Spin up a scratch Postgres of the matching major:
   `docker run --rm -p 5433:5432 -e POSTGRES_PASSWORD=postgres postgres:<N>`
3. `pg_restore --no-owner --no-privileges -d "postgresql://postgres:postgres@localhost:5433/postgres" dump-….dump`
4. Row-count sanity check vs. production for the key tables: `Warehouse`,
   `Enquiry`, `MessageLog`, `Draft`, `VerifiedNumber`, `GeocodeAttempt`,
   `CronRunLog`.
5. Full DR into a fresh Supabase project: create the project, then restore as
   above against its direct connection. Auth users will not transfer (they
   live in the excluded `auth` schema).

---

## 10. Out of scope (v1)

- Point-in-time recovery (requires WAL archiving — a Supabase platform
  feature, not something to bolt on from outside).
- Cross-region replication (add an S3 Replication rule later if needed —
  cheap).
- Restore automation.
- Customer-managed KMS encryption.
- Off-box trigger for the case where the EC2 is terminated or down >24h.
