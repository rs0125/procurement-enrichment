# Follow-up audit fixes — 28 September 2026

This change addresses the three findings reproduced against release `83c1306`.

- Prisma client, PostgreSQL adapter and CLI are pinned to **7.10.0**. Inspection
  of the published client source confirms that its transaction-timeout cleanup
  catches rollback errors. A regression runs a child process with strict
  unhandled-rejection handling, drops PostgreSQL responses mid-transaction,
  verifies no partial write committed, and completes a new transaction afterward.
- The nightly geocoder uses the shared action/executor, guarded coordinate and
  failure publication, the durable cron lock, a 100-item/10-minute bound, and
  cancellation/draining. Its existing nightly schedule and eligibility/cooldown
  remain. HTTP acknowledgement is now asynchronous 202, with authenticated
  status and dry-run endpoints; see `HTTP_API.md`.
- Runtime, canary and builds use dedicated non-login accounts, no privilege
  escalation, empty capabilities and restricted persistent filesystem writes.
  Runtime buffers move to `/var/lib/warehouse-enricher/buffers`; existing buffers
  and backup configuration are retained for rollback. The root-owned deployment
  helper must be installed separately before the application push activates this.

Local verification passed **74 JavaScript tests and 14 deployment tests**,
Prisma validation/generation and the seven-action CLI registry. It covers transaction network loss, geocoder edit races,
invalid coordinates, retry cooldown/caps, duplicate runs, cancellation, HTTP
contracts, native encoding, shared image/proximity contracts, and deployment
rollback/isolation guards. Production failure injection is not required.

No table migration, backfill, model-policy change or queue cutover is included.
The two-night stability gate and operational alerting remain relevant after
these fixes. Resource caps contain failures; they cannot promise zero future OOMs.

The upgraded production dependency audit reports four high-severity package
entries in Prisma tooling (`prisma`, `@prisma/config`, `deepmerge-ts`, `mysql2`),
down from 15 entries. This is not a clean dependency-security sign-off.
