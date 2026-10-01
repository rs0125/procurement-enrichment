# Enrichment delivery contract with PGMQ

Status: **proposed, not a migration**, 29 September 2026. The
[PGMQ evaluation](PGMQ_EVALUATION.md) replaces the earlier custom work-table
contract. Production still uses crons. Read with the
[architecture](QUEUE_ARCHITECTURE.md) and [rollout](QUEUE_ROLLOUT.md).

## Queue messages and source identity

Use one fixed, durable PGMQ queue initially, proposed name `enrichment_jobs`, plus
an operator-inspected dead-letter queue. Keep the `pgmq` schema outside browser
API access. Use the existing server-side `pg` pool; no Edge Function or second
queue SDK is required. Do not use unlogged queues.

Example bounded payload:

```json
{"v":1,"action":"webp","subjectId":"456","lane":"live"}
```

Actions and lanes are allowlisted. IDs are bigint-safe strings. Messages contain
no original URLs, image bytes, copied warehouse documents, model output, provider
secrets or arbitrary retry/model parameters. The worker resolves current data
from the subject's owner. Explicit policy-version reprocessing is an audited
operator request, not an implicit effect of a new software default.

| Action | Subject | Source checks |
|---|---|---|
| `refresh-warehouse` | Warehouse ID | Current media, visibility, Maps URL and coordinates |
| `geocode` | Warehouse ID | Maps URL, coordinate state and existing eligibility/attempt history |
| `proximity` | Warehouse ID | Coordinates, existing tolerance, current category facts and coverage |
| `image-label`, `website-approval`, `webp` | Registry image ID | Original identity, active global membership, existing stage and policy rules |
| `document-kind` | Registry image ID | Original identity and completed DOCUMENT scene |
| `jpeg` | Registry image ID | Original identity and scene-derived photo/document sizing policy |

`pgmq.send` does not enforce logical uniqueness. A duplicate notification gets a
new message ID. This is acceptable only because readiness and per-action claims
prevent repeated effects and preserve retry limits. Queue depth is not a count
of images needing paid work. A single active consumer reduces overlap, but does
not replace those correctness checks during crashes, deployments or retries.

## Atomic enqueue and edits during execution

A narrow source trigger sends a `refresh-warehouse` message in the same database
transaction as the relevant warehouse change. It compares relevant values with
`IS DISTINCT FROM`, does no provider work, and never fires on queue or derived
result updates. Source save and delivery intent either commit together or fail
together. Source-trigger failure therefore fails the warehouse save; test that
API error path rather than acknowledging a save whose event was lost.

A second source edit creates a second message. Finishing the first message cannot
acknowledge the second ID. Read the latest source on dispatch and guard its
identity again at publication. This removes the need for custom queue
`generation`/`claimed_generation` columns just to preserve edits in flight.

The existing post-commit image registration hook is not the durable producer.
Keep it during shadow rollout, then retire it only once refresh replaces it.
Staged creation and approval linkage must become one transaction before immediate
consumption, so compensated provisional warehouses cannot trigger provider work.

The refresher registers current original URLs, repairs legacy projection where
needed and schedules missing eligible actions. Preserve canonical `Warehouse.media`
membership/order; legacy `photos` applies only when `media.images` is absent.
An explicit empty array remains authoritative. One image may have several owners;
the historical image `warehouseId` is not the membership index.

Fan-out and reconciliation use bounded pages, initially 50 IDs. Do not acknowledge
incomplete fan-out or allocate an unbounded job array. If actual media sizes need
a resumable cursor, introduce one deliberately. Before adding persistent
coalescing, measure duplicate events and avoid repeated reconciliation enqueueing
of already-outstanding actions. Ordinary reconciliation never revives terminal
failures, resets attempts, or reprocesses READY/reviewed results.

## Claim, execute and guard the receipt

Pass memory/disk admission and reserve the existing executor **once**, then call
`pgmq.read` for one message with a five-minute visibility window. Zero prefetch.
Commit the claim before any provider call. Retain the 180-second action budget;
v1 does not renew indefinitely to accommodate oversized work.

PGMQ uses atomic competing-reader claims and hides that message until its
visibility expires. But raw `archive(queue, msg_id)` and `set_vt` do not verify
that the caller still owns the delivery. The local tests reproduced a stale
worker archiving a newer delivery in both tested extension versions.

The private adapter must perform this sequence in a short transaction:

1. Lock required domain source/result rows in deterministic order and validate
   current source identity, membership and any existing stage claim.
2. Lock the allowlisted PGMQ queue row, requiring the same `msg_id`, the receipt's
   `read_ct`, and `vt > clock_timestamp()`. Reject a missing, expired or superseded
   receipt, including one that has expired without yet being redelivered.
3. Publish the result and/or schedule dependents, then archive or reschedule under
   that lock. Never expose a raw acknowledgement path to HTTP callers.

The queue-row lock prevents redelivery while that transaction commits. Keep it
short, with lock/statement timeouts and no network calls; no database connection
is held for the duration of provider work. Use domain-then-queue lock order in
publication; the initial claim touches only the queue. Test trigger-versus-result
races and deadlock retries in the real action repositories.

The receipt guard depends on the internal PGMQ table layout. Allowlist identifiers,
pin the supported extension version, and regression-test upgrades. The prototype
is a correctness sketch, not a production security-definer function.

Keep image-stage claims as a second guard. Distinct duplicate messages can refer
to the same image. JPEG, geocode and proximity also need ownership/source checks
at publication, and a per-subject guard where existing actions lack one.
Pre-call checks alone cannot fence a late provider response.

## Publish, acknowledge and follow up

A domain result may be committed before its message is acknowledged. On redelivery,
recognize that result, ensure its dependents, and archive without another paid
call. READY is not permission to skip dependent scheduling or projection repair.
Scene completion wakes subtype and explicitly requested JPEG work; coordinate
publication wakes eligible proximity work.

Dependent sends and parent acknowledgement share one database transaction. If
publication and dependent scheduling use separate commits, the READY recovery
path must repair that gap. Do not place R2 or provider calls inside a transaction.
Deterministic variant keys and conditional publication allow reuse after an upload;
provider billing can still repeat after a crash before the response is persisted.
A stray upload is not automatically an enterprise-wide orphan.

An obsolete delivery can be archived with a reason after current source is
re-evaluated. Its new notification is independent. Never publish the obsolete
result or change another message's retry time while cleaning it up.

## Domain disposition and retries

| Condition | Delivery outcome |
|---|---|
| READY or already current | Ensure dependents/repairs; archive current receipt |
| Website BLOCK or REVIEW | Completed assessment; archive, never retry into ALLOW |
| `ready_ineligible_or_claimed` | Re-read stage state, lease, attempts and retry time; not blindly successful |
| Waiting for scene/coordinates | Ensure eligible prerequisite; defer without a paid attempt; park terminally blocked dependents |
| Provider failure | Mirror domain retry time or terminal budget; do not add another full attempt allowance |
| Source changed / membership gone | Re-plan or archive obsolete delivery; shared images remain eligible through other owners |
| PARTIAL proximity | Retain completed categories; defer only eligible missing work |
| Memory pressure, busy executor, pre-work shutdown | Defer without consuming a provider attempt; monitor prolonged deferral |
| Missing configuration / credentials | Pause or park the affected action type and alert; avoid exhausting every row |
| Unsupported source | Terminal reason, distinct from exhausted transient failure; no endless polling |

`read_ct` counts deliveries, including unpaid deferrals. **Never use it alone as
the five-paid-attempt budget.** It identifies a receipt for fencing, not business
retry policy.

| Action | Retry ownership |
|---|---|
| Label, subtype, approval, WebP | Existing registry stage: five started attempts, 5/10/20/40-minute spacing; mirror its next-attempt timestamp |
| Geocode | Extract seven-day eligibility, five attempts, 24-hour spacing and two-second pacing from cron into shared policy |
| Proximity | Extract coordinate-specific exponential cooldown, initially 15 minutes and capped at six hours; preserve category facts/tolerance |
| JPEG / operational unknown outcomes | Define minimal durable attempt accounting where the domain currently lacks it; bounded backoff and terminal state are required before enabling these actions |

Finalize missing attempt accounting during Phase 1. Do not recreate a scheduling
engine to store it, or rely on mutable in-memory counters. Reserve a started
attempt durably before paid work where no existing stage does so; after a crash,
check saved results before retry/dead-letter decisions. Harmless deferrals and
completed-result reuse must not consume paid attempts. Terminal exhaustion must
remain durable even if delivery history is later pruned.

`GeocodeAttempt` remains warehouse-scoped for this migration. A changed Maps URL
must not silently clear prior success/exhaustion or trigger fleet re-geocoding.
Manual/Sol-reviewed image results and current privacy rules remain authoritative.
A policy change or domain-attempt reset is a separate audited operation.

Move exhausted work into the fixed dead-letter queue and archive its active
message in one fenced transaction. Include bounded sanitized reason/correlation
metadata, not provider responses. A dead-letter queue does not define our retry
policy by itself, and normal reconciliation must not re-create exhausted work.

## Consumer, API and operations

Use the shared five-connection pool and existing one-action executor. Retain all
memory, native decoder, download, disk and action caps in the architecture plan.
PGMQ does not make encoding faster or prevent OOM by itself.

Start idle polling at five seconds with jitter, backing off to 30 seconds when
empty or unavailable. Use allowlisted action/lane filters and measure their query
plans. Preserve bounded action fairness and a backfill share. Do not rely on
newer upstream FIFO/group features unavailable in our project's 1.5.1 extension.

In queue mode, authenticated action routes/CLI enqueue or reject inline execution;
they cannot start a second provider owner. Return `202` with a string message ID
and subject/action. Duplicate requests may return different message IDs; status
must also report current domain readiness, waiting and terminal reasons. Dry runs
perform no enqueue, claim, provider call, upload or run-log write.

Maintenance endpoints retain their authentication contracts. Their parent run now
reports reconciliation/dispatch, enqueued counts and backlog, not completion of
all child work. Keep `CronRunLog` and queue IDs distinct. Website builds remain
independent, and JPEG remains explicitly requested until separately approved.

Stop claiming on shutdown, abort/drain active work and its decoder, then attempt
a guarded reschedule. If cleanup/DB access is uncertain, leave visibility to expire.
Never acknowledge unfinished work in `finally`. PGMQ handles expired-message
redelivery; no custom RUNNING-row lease-reaper is needed. Application reconciliation
still repairs missed producers, dependencies and current eligibility.

Restrict schema/functions to intended server roles, fix security-definer search
paths and object qualification, and test actual Supabase grants. Browser roles
must not enqueue paid work, inspect private records or reset attempts. Keep
`pgmq_public`/public queue APIs disabled unless separately needed and reviewed.

Retain dead letters until reviewed. Bound archive retention, initially 30 days,
without deleting the only evidence of retry exhaustion. Log message ID, action,
subject and sanitized disposition; avoid original URLs, numbers or credentials.

The [version-specific backup findings](PGMQ_EVALUATION.md) are a release gate.
Restore queue data/metadata/sequence state and domain state consistently, with
consumers disabled. Preserve pending explicit requests and terminal retry state;
reconcile before resuming. A restored receipt can replay work, so ensure all old
consumers have stopped. Queue restoration cannot restore missing R2 bytes.
