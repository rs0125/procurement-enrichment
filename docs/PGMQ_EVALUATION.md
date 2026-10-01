# Supabase Queues / PGMQ evaluation

Date: **29 September 2026**. Scope: read-only Supabase metadata inspection and
local disposable PostgreSQL tests. No production extension, trigger, queue,
worker, role or backup configuration was changed.

## Decision

**Prefer PGMQ for delivery over the proposed custom work table.** Keep the
existing EC2 action executor, image-stage claims, source validation, provider
retry rules and reconciliation. Do not introduce another broker or worker host.

This replaces the earlier custom-table preference. PGMQ removes the need to own
the basic queue storage, visibility scheduling, concurrent claim query and
redelivery engine. It does **not** remove the application work needed to make
enrichment safe. The rollout remains gated on guarded acknowledgements,
version-specific backup/restore, actual Supabase permissions and the existing
cron stability gate.

The revised [architecture](QUEUE_ARCHITECTURE.md), [contract](QUEUE_CONTRACT.md)
and [rollout](QUEUE_ROLLOUT.md) describe that direction. This is a design decision,
not approval to enable production consumers immediately.

## What was checked

| Environment | Finding |
|---|---|
| Our Supabase project | PostgreSQL 17.6; PGMQ **1.5.1 available, not installed**; metadata queried in a read-only transaction |
| Local runtime | PostgreSQL 17.11, Podman, one CPU, 512 MiB container limit, persistent disposable volume |
| Versions tested | Exact upstream PGMQ 1.5.1 and 1.13.0 SQL, installed in separate databases |
| Application integration | Fixture SQL and Node `pg`; no actual providers, R2 writes, enterprise records or deployed worker |

Supabase Queues uses PGMQ and provides durable messages and visibility handling.
Its delivery guarantee is scoped to the visibility window; it does not make
external provider calls exactly-once. [Supabase documentation](https://supabase.com/docs/guides/queues).
The current project version matters more than the newest upstream feature list.

Reproducible fixtures and pinned source hashes are in
[experiments/pgmq](../experiments/pgmq/README.md). Each version passed **16 contract
tests**, including deliberate negative controls; both also passed the forced
database restart and fixture restore checks.

| Check | Observed result |
|---|---|
| Source trigger + `pgmq.send` | Both commit together; rollback and trigger failure leave neither source nor event |
| Concurrent claims | Eight clients claimed 64 distinct messages without overlap |
| Consumer disconnect / visibility expiry | Same ID redelivered with incremented `read_ct` |
| Forced PostgreSQL SIGKILL + restart | Pending and archived data survived; unacknowledged message redelivered |
| Delay / reschedule | Message was unavailable before its due time |
| Duplicate sends | Two message IDs; PGMQ does not deduplicate our logical action |
| Stored result before lost acknowledgement | Fixture reused the stored result without a second simulated provider call |
| Edit while processing | New message survived the old acknowledgement; fixture source guard rejected old output |
| Parent acknowledgement + dependent send | Transaction rollback preserved the parent and left no child; retry committed both |
| Raw stale acknowledgement | **Unsafe negative control:** old worker A archived worker B's current delivery |
| Guarded acknowledgement / retry | Old or expired receipt rejected; current receipt accepted |
| Unpaid deferrals | `read_ct` increased despite no provider attempt |
| Dead-letter transfer | Transfer and parent archive committed atomically |
| Unprivileged local role | Could not access the vanilla extension schema; this does not certify hosted Supabase grants |

The fixture models result reuse and source revisions, not real concurrent model
calls. Production still needs per-action claim integration and membership checks.
The local timing smoke test drained 1,000 messages with one receipt at a time in
about 12 seconds on 1.5.1 and 16 seconds on 1.13.0. Those numbers include local SQL
and guarded acknowledgement only. They are neither a version comparison nor a
prediction of Supabase latency, EC2 capacity or provider throughput.

## Two findings that affect implementation

### Visibility is not a receipt ownership check

In both tested versions, `archive(queue, msg_id)` accepts only the ID. After a
timeout and redelivery, a slow old worker can still archive the new worker's
message. `set_vt` similarly needs guarding. The
[1.5.1 implementation](https://github.com/pgmq/pgmq/blob/v1.5.1/pgmq-extension/sql/pgmq.sql)
matches the observed behaviour.

The tested adapter locks the queue row and verifies `msg_id`, the delivery's
`read_ct`, and a still-valid `vt` in the same short transaction as publication or
acknowledgement. If source locks are needed, it acquires them first. A raw
acknowledgement in a `finally` block is not safe.

This wrapper depends on PGMQ's internal queue-table layout. Pin and inspect the
deployed extension version, regression-test upgrades, allowlist queue names, and
restrict access to privileged wrappers. Keep the existing domain-stage token as
well: two duplicate messages can refer to the same image even while each message
has an exclusive delivery.

### Our existing logical backup needs explicit changes

The checked-in [backup script](../deploy/backup/backup.sh) defaults to `public`.
That excludes PGMQ. More significantly, **adding `pgmq` to the schema list was
insufficient on 1.5.1**. The fixture's pending rows, archived rows, metadata and
queue definitions were absent. Selecting the extension or its tables explicitly
did not fix that version's dump either.

PostgreSQL normally excludes extension member objects from ordinary dumps;
extension configuration tables need special treatment.
[PostgreSQL extension backup documentation](https://www.postgresql.org/docs/17/extend-extensions.html#EXTEND-EXTENSIONS-CONFIG-TABLES).

| Version | Tested restore path |
|---|---|
| 1.5.1, available on our project | Explicit fixture export of queue metadata, pending/archive records and sequence state; recreate same-version queues and restore all fields. Data and next ID matched. |
| 1.13.0, comparison only | Extension-aware `pg_dump --schema=pgmq --extension=pgmq`, with extension version pinned on restore. Queue data, metadata, indexes and next ID restored. |

The 1.5.1 exporter is a **small-data proof of feasibility**, not a production
backup tool: it does not stream large queues, include grants, or share a snapshot
with the warehouse dump. Production must implement and restore-test those pieces,
or use a supported version/backup path that already preserves them. Do not patch
extension internals or force an unsupported hosted upgrade to bypass this gate.
This finding concerns our logical S3 dump; it does not establish anything about
Supabase-managed physical backups or PITR.

## What remains our responsibility

- Source membership, coordinates, policy/version identity and stale-result guards.
- Domain retries/cooldowns. `read_ct` is deliveries, not paid attempts. JPEG and
  operations without a durable attempt budget still need a small persisted policy.
- Per-subject claims, result reuse, safe R2 publication and dependency scheduling.
- Privacy decisions: BLOCK/REVIEW are completed assessments, not retry conditions.
- Fairness, one active action, existing memory/disk caps and admission checks.
- Restricted worker permissions, API-only deployment canaries, shadow rollout,
  dead-letter inspection, archive retention, monitoring and reconciliation.

## What can be simpler than the previous proposal

Send small immutable ID messages in the source transaction and read current
source state when processing. A later edit creates a new message. Acknowledging
the old message cannot remove the later edit's notification, so a custom queue
slot with `generation` / `claimed_generation` is not required for that guarantee.

Accept duplicate notifications initially. Current READY checks and action claims
must prevent duplicate effects and preserve retry budgets. Reconciliation should
avoid repeatedly enqueueing known outstanding work; add persistent coalescing
only if measured volume requires it. No custom scheduling table is needed merely
to deduplicate cheap notifications.

The production gates still include real source-versus-trigger races, all seven
action integrations, hosted-role grants, full consistent backup/restore, provider
faults and deployment overlap. Passing these local queue primitives is useful
evidence, not a claim that the complete queued enrichment pipeline is deployed or
already production-ready.
