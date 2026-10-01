# Consistent domain and queue backups

The independent daily S3 backup timer stays active. Because ordinary `pg_dump`
omits PGMQ 1.5.1 queue state, the updated backup produces one `.tar` containing a
compressed `domain.dump`, streamed COPY files for queue metadata/pending/archive
rows, sequence states, and a manifest with SHA-256 checksums. Domain data and
queue rows share one exported repeatable-read snapshot. Sequence values may be
ahead of the snapshot, which prevents ID reuse. Dead letters are included.

The exporter supports ordinary durable queues on exactly PGMQ 1.5.1. Unsupported
versions/layouts fail instead of silently omitting data. Before PGMQ installation,
the same helper backs up the configured domain schemas. The private `enrichment`
schema is included whenever present. Streaming keeps memory independent of queue
size. This is not a backup of R2 bytes or all Supabase-managed schemas/auth roles.

`run.mjs` uploads only a completed artifact and records format/key/size in
`CronRunLog`. Credentials stay in environment/parameterized database connections,
not subprocess arguments or error output, including failure logging. Node has a
128 MiB heap limit; both backup and failure services run as the dedicated
non-login `warehouse-enricher-backup` account with a 384 MiB process-group limit,
256 MiB soft limit and 64-task limit. The existing systemd timeout remains. A file lock prevents overlapping backups.
Failure retains the existing marker for the failure service.

The updated release helper installs `run.mjs`, `snapshot.mjs` and the launcher
under root ownership outside application releases. Dependencies resolve through
current's `node_modules`; supported older releases already contain `pg`. The
installed privileged helper supplies the systemd isolation policy, verifies it
before copying release-provided JavaScript, and refuses installation while a
backup/failure logger is active. Git revisions do not select a privileged backup
user. Systemd loads the existing root-only environment file. Only the dedicated
backup directory is writable persistently.

Update the installed root helper first. It retains the queue helper when an older
application release has no queue backup modules, and rejects incomplete module
pairs. Backup setup precedes application promotion. Verify effective `User`,
`Group`, `NoNewPrivileges`, `CapabilityBoundingSet`, `ProtectSystem` and
`MemoryMax` on both units, then run a backup and isolated restore. No new AWS or
database key is required. These host changes were deployed on 1 October 2026;
the first production bundle uploaded successfully. The production-shaped restore
and queue round-trip passed after the restore-helper fixes described in the
[production record](PRODUCTION_2026-10-01.md). Those fixes were released as
`fe6a8e9`; the installed helper matches. A live backup at 18:20 UTC on 1 October
included `enrichment_jobs`, `enrichment_dead`, and the private `enrichment` schema.

## Isolated recovery

Never restore over production or start consumers during recovery. Use a fresh
replacement database with matching PostgreSQL and extension versions. The
1 October rehearsal uses `supabase/postgres:17.6.1.178` (PostgreSQL 17.6), which
provides pg_net 0.20.4 as well as the other exact manifest versions. Tag
`17.6.1.136` has pg_net 0.20.3 and is not compatible with that backup.

Prepare extension prerequisites before restoring: preload `pg_stat_statements`,
`pg_cron` and `pg_net`, set `cron.database_name` to the target database, and keep
`cron.launch_active_jobs=off`. Rehearsal containers use `--network=none` and a
private Unix socket, so even restored functions cannot send external callbacks.
Do not expose the copied production data on a public database port.

Schema dumps retain RLS policies even with `--no-owner --no-privileges`. They do
not create cluster roles. The 1 October domain dump references `ramesh_worker`
and `wog_ro`; create those identities as restricted `NOLOGIN` roles in a clean
rehearsal target before restoring. Inspect the trusted dump for dependencies
when rehearsing a newer backup. Do not copy production passwords or grant broad
access to make recovery succeed. Actual login/membership/ACL recovery is separate
from verifying this domain-and-queue bundle.

1. Download/extract the bundle into a private directory. Inspect `manifest.json`.
   Export the replacement `BACKUP_DATABASE_URL` securely; use direct/session mode.
2. Run `node deploy/backup/snapshot.mjs restore /absolute/extracted-directory`.
   It validates the exact table/file/sequence inventory, hashes, column layouts
   and extension versions, rejects existing application tables/sequences, installs
   extensions, restores queue metadata/data/sequences, then restores domain data
   and post-data triggers. A failed restore is unusable; retry in a fresh database.
3. Run reviewed `sql/queue/001_bootstrap.sql` and `002_capture_functions.sql` to
   reinstall private wrapper grants; dumps omit owner/ACLs. Grant only the backend
   its intended role/domain permissions. Restored private functions are revoked
   from PUBLIC before the helper succeeds.
4. Inspect source triggers. Post-data restore recreates them if enabled in the
   snapshot. Use `004_disable_capture.sql` for rehearsals that should not capture.
5. Verify domain rows, queues, archive/dead letters, claim state, permissions and
   next IDs. `npm run queue -- doctor` must pass. Fence the old worker before any
   replacement begins processing.
6. Allow restored five-minute claims/leases to expire if necessary. Resume only
   after verification. Never reset attempt budgets to accelerate recovery.

`tests/queue.backup.test.mjs` proves that a domain write and event committed after
snapshot export are both excluded, while claim count/visibility, archive/dead
letters and sequence IDs survive. Rehearse a production-shaped isolated restore
before cutover as well as this local fixture test.

Cancellation waits for child exit, escalating to SIGKILL after two seconds if
needed. Loss of the snapshot-owning database connection cancels the export and
removes its staging directory. Checksums detect corruption; they do not establish
the authenticity of an untrusted backup. Restore only trusted private artifacts.
