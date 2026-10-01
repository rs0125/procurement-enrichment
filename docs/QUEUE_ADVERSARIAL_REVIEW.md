# Queue integration adversarial review — 30 September 2026

Status: fixes and verification completed locally. No commit, push, production SQL,
EC2 change, provider request or R2 upload was performed by this review. Production
remains on cron processing. The queue rollout still needs its deployment gates.

## Scope and method

Reviewed the queue SQL boundary, explicit and reconciliation delivery paths,
guarded action adapters, dependency/retry decisions, paged refresh, worker
leadership/health/shutdown, staged warehouse approval, backup/restore and the
privileged deployment helper. Used the locked Node/Prisma dependencies and a
disposable PostgreSQL 17/PostGIS container with PGMQ 1.5.1. Tests use synthetic
rows and fixture providers; destructive faults never target production.

Four queue regression tests and the approval response regression were run against
the original local implementation and failed as expected before correction.
Deployment privilege findings came from code inspection, with regression tests
for the resulting policy. Additional fault tests kill owned local processes and
database sessions and validate recovery against real PostgreSQL.

## Findings and corrections

| Priority | Failure | Correction and evidence |
|---|---|---|
| P1 | A new explicit request reused the ID of an already-running job. Acknowledging the older delivery removed both intents. | Explicit HTTP/CLI requests now enqueue independently. Only cron repair uses pending-job coalescing. Real database regression confirms the new request remains after the old acknowledgement. |
| P1 | Atomic staged approval returned every physical database column through `to_jsonb`, exposing fields omitted by Prisma. | Project the response through generated scalar/enum fields. The real approval fixture includes an unknown internal column and unsupported geography/vector fields and confirms they are absent. Original media, coordinates and response dates are preserved. |
| P1 | The backup systemd unit ran release-provided JavaScript and dependencies as root. The root installer could also follow release symlinks to private host files. | A dedicated non-login backup account, empty capabilities, restricted writable directory and 384 MiB hard cap are supplied by the separately installed privileged helper. It verifies effective isolation before installing code and rejects sources outside the release or symlink files. Regression tests cover ordering, privilege/cap regressions, active backups and file/directory symlink escapes. |
| P2 | A geocode in its 24-hour cooldown was treated as permanently unavailable, dead-lettering dependent proximity work. | Dependency decisions distinguish waiting from terminal outcomes. The real database regression keeps proximity deferred and a geocode prerequisite pending. |
| P2 | Coordinate jitter below the existing tolerance bypassed proximity cooldown accounting. | Attempt comparison now uses the same coordinate tolerance as publication/coverage. A provider-failure fixture followed by a 0.0000000005-degree edit confirms no second immediate call. |
| P2 | Refresh ignored a failed final receipt check, committing registration and reporting success when visibility expired during the transaction. | Failed cursor/advance/finish ownership checks throw and roll back the transaction. A deliberately slowed registration with a 150 ms receipt expires, reports stale and commits neither registration nor acknowledgement. |
| P2 | Repeated queue polling failures could still report healthy. Silent session-lock loss was not actively detected; concurrent startup could acquire more than one leader connection. | Health fails after three consecutive unavailable polling cycles. Idempotent startup, a ten-second backend/lock heartbeat, a 45-second server idle timeout and drain handling fence failed workers. Tests cover recovery, interrupted startup, competing workers and terminating the actual leader database session. |
| P2 | Backup abort handling could clear its SIGKILL deadline before an uncooperative child exited. Snapshot connection errors could escape cleanup. | Await child close, terminate on input failure, escalate after two seconds, and cancel export on owner connection loss. Tests use a SIGTERM-ignoring child and terminate the actual exported-snapshot owner. |
| P2 | Restore trusted a partial manifest and could omit queue tables, sequences or hashes. A PGMQ installation with zero queues skipped its metadata restore. | Validate the exact inventory and unique metadata before connecting, compare restored column layouts, require hashes for every artifact and handle metadata even with zero queues. Malformed manifests are rejected; the full domain/queue restore round trip passes. |
| P2 | Deploying an older application release without the new backup modules failed after application promotion and could undermine rollback. Failure logging also put a database URL in `psql` arguments. | Retain installed queue helpers for pre-queue releases, reject incomplete pairs, and set up backup before promoting the app. Failure logging now uses parameterized `pg` calls and retains its marker until logging succeeds. Deployment and failure-marker regressions pass. |

`P1` denotes a high-priority correctness/security defect to fix before rollout;
`P2` denotes a recovery, reliability or operational defect requiring correction.
These priorities describe this implementation review, not an observed production
incident or evidence that any private data was accessed.

## Verification results

- Enricher: **127 passing JavaScript tests, zero failures or skips**. Includes all
  seven guarded action adapters, permissions, transactional capture, source and
  receipt races, attempt/cooldown boundaries, dependency repair, serial admission,
  fairness, real encoder outputs, leadership and consistent backup/restore.
- Deployment: **19 passing Python tests**, including existing rollback/SSM guards
  and new non-root backup policy, installation ordering and symlink rejection.
- Dashboard: **31 passing focused unit/API tests** and **16 passing real database
  integration tests** for approval/reopen. Concurrent approvals produce one linked
  warehouse; failed details/link writes roll back the warehouse and captured event.
- The backup round trip preserves pending jobs, receipts, archives, dead letters
  and sequence safety; a domain write and event committed after snapshot export
  are both excluded.

Relevant files: `tests/fixtures/queueActionCases.mjs`, `tests/queue.database.test.mjs`,
`tests/queue.runtime.test.mjs`, `tests/queue.test.mjs`, `tests/queue.backup.test.mjs`,
`tests/deployment_test.py`, and the dashboard's
`tests/integration/promote.test.js`.

## Remaining rollout gates and limits

1. Install the reviewed privileged EC2 helper separately; a push does not replace
   it. Verify the effective backup account/caps, a successful S3 backup, and an
   isolated production-shaped restore. Local unit tests do not certify the live
   host's systemd settings, permissions or storage capacity.
2. Deploy atomic approval and the enricher in cron mode, apply reviewed additive
   SQL/grants, then enable source capture in shadow mode. Keep crons processing
   while measuring capture latency and comparing committed changes with events.
3. Complete the restricted execution gate before broad queue consumption. The
   current runtime has no subject allowlist; either implement/test one or use an
   isolated queue/database containing only reviewed subjects. Do not call an
   unrestricted worker a small production canary.
4. During cutover, drain inline provider work before queue ownership. Crons remain
   scheduled as reconciliation; retain inline handlers for rollback. Observe two
   full nightly cycles, including backup, before removing any fallback.

Delivery remains at least once. A crash after an external provider call or upload
but before publication can repeat that external operation. Receipt/source checks
protect publication; they cannot promise exactly-once billing. These local tests
also do not establish sustained production throughput or guarantee that a bounded
process can never hit its configured memory limit.

See [setup](QUEUE_SETUP.md), [backup/recovery](QUEUE_BACKUP.md) and
[rollout](QUEUE_ROLLOUT.md) for execution steps.
