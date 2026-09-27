# Enricher adversarial audit — 27 September 2026

The deployed `d48249d008eeb47b6190ac24ed55d306ca85058b` release has useful
resource limits and retry fencing, but this audit found issues that prevent an
unqualified production-readiness sign-off. This report records the pre-deployment audit. The changes alongside it address
the findings below. Deploying them requires updating both the application release
and the separately installed deployment helper.

## Confirmed findings and local fixes

| Priority | Finding | Reproduction / impact | Local fix |
| --- | --- | --- | --- |
| P1 | Geocoder URL validation allowed arbitrary outbound requests | An input such as `http://127.0.0.1/?goo.gl` entered the short-link resolver because it used a substring check. A mocked fetch confirmed the request. This requires control of a warehouse Maps URL; no attack was attempted against production. | Match exact short-link hosts, use HTTPS, validate each redirect against Google hosts, reject credentials/custom ports, cap redirect count, cancel unused response bodies and bound CID response bytes. |
| P1 | Vulnerable image-decoder dependency | Sharp 0.33.5 falls within published libvips/libheif advisories. Memory limits do not substitute for patched native decoders. | Update Sharp to 0.35.5; verify actual JPEG/WebP encoding. Also update the S3 SDK and compatible HTTP parser dependencies. |
| P1 | Database stalls could hold the only worker | The deployed pool had no connection/read timeout or lock timeout; its server statement timeout was two minutes. A blocked-query test required external cancellation; a lost connection could be worse. | Five-second connection/acquisition timeout, three-second lock timeout, ten-second statement timeout, fifteen-second read/idle-transaction timeout, five connections. Await session configuration before lending a connection. |
| P2 | Shutdown could miss a cron being accepted | `drain()` returned while the acceptance write was pending. Shutdown could leave an acknowledged or stranded RUNNING record until the 15/50-minute stale-run window. A concurrent caller could get a successful acknowledgement even if acceptance subsequently failed. | Track the acceptance promise, drain it, close accepted-but-unstarted runs on shutdown, and acknowledge only persisted run IDs. |
| P2 | Stage audit failures suppressed independent stages | Injecting a failure into label run-log acquisition/completion prevented the website and proximity stages from running. | Contain audit failures within their stage and report degraded completion while continuing independent stages. |
| P2 | Exhausted retries could look healthy | A batch with FAILED/UNSUPPORTED rows but no due retries returned SUCCESS. | Include unresolved backlog in the batch status. Successful BLOCK website decisions remain READY and do not become operational failures. |
| P2 | Public errors exposed exception text | Synthetic private exception text appeared in responses and logs; `/health` also returned raw database errors. No actual credential leak was established. | Generic public errors, safe logging and explicit 400/413 responses for invalid/oversized JSON. |
| P2 | JPEG publication lost timestamp precision | An existing JPEG timestamp with microseconds made an otherwise valid compare-and-set publication fail. | Carry the exact timestamp text; a one-microsecond concurrent edit still rejects stale publication. The live audit found no affected timestamps currently. |
| P2 | Deployment builds lacked a whole-process memory cap | The installed helper capped Node heap, but not native allocations or child processes during builds. It also allocated another 768 MiB ceiling to its health-only canary. | Build scope: 640 MiB hard cap, 512 MiB soft cap, 128 tasks, one CPU and a runtime cap. Canary: 384 MiB hard cap. Include all application tests in ARM release verification. These are helper changes and are not active until installed administratively. |

The Sharp findings are documented by the maintainers in
[the libvips advisory](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj)
and [the libheif advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).
The old S3 dependency tree included `fast-xml-parser` 5.2.5, covered by
[its maintainer advisory](https://github.com/NaturalIntelligence/fast-xml-parser/security/advisories/GHSA-m7jm-9gc2-mpf2).
An advisory match is not evidence that a particular application path is exploitable.

## Validation

- All **66 JavaScript tests** passed against the updated dependencies, including
  the disposable local PostGIS database. All **11 deployment tests** passed.
- Delayed cron acceptance, concurrent acceptance failure and shutdown races
  were reproduced before their fixes.
- A real database lock now fails after approximately three seconds and leaves
  the connection usable. A TCP peer that never responds fails after five
  seconds. A proxy dropping query responses fails after fifteen seconds and
  the pool successfully reconnects afterward.
- Hostile and normal Maps redirects, redirect loops, oversized responses,
  malformed HTTP bodies, byte limits, decoder cancellation, low-memory
  deferrals and temporary-file cleanup have automated coverage.
- Existing database tests still cover stale claims, concurrent edits,
  preservation of raw media, completed website decisions, legacy WebP
  fallbacks and proximity/geocoder publication fencing.
- Prisma generation/validation and the seven-action CLI registry passed.
- The new session settings were checked on a separate read-only connection
  through the actual Supabase pooler: 10 s statement / 3 s lock / 15 s idle
  transaction. Application configuration and database data were not changed.
- A tiny temporary EC2 scope verified the proposed build caps: 671088640-byte
  memory maximum, 536870912-byte soft limit, 128 tasks and one CPU. No production
  service restart or resource-pressure experiment was performed.

## Live observations

The production service still runs `d48249d`. At the read-only checks it had
**zero OOM events, zero OOM kills and zero restarts**, a peak cgroup usage of
254472192 bytes (242.7 MiB), and the expected 640/768 MiB soft/hard service limits.
No abandoned image buffer directories were present. The installed deployment
helper matched that release.

Recent migrated sweeps completed successfully. There were no exhausted label,
website or WebP retry rows in the inspected 16611-row image table. The older
nightly geocoder's last two error summaries each represented one candidate
returning `no_match`, not a database outage or OOM. That input still needs a
data-quality correction; this audit did not edit its location or coordinates.

## Remaining work and limits

1. **Deploy the reviewed changes and install the updated root-owned helper.**
   A normal application push does not replace
   `/usr/local/sbin/warehouse-enricher-deploy`. Run CI, verify the new decoder on
   ARM and canary health, then observe scheduled execution. No production table
   changes or backfill are required for these fixes.
2. **Address the remaining Prisma tooling advisories separately.** The initial
   production-dependency audit reported 38 affected package entries (1 critical,
   12 high, 24 moderate, 1 low). After the targeted update it reports 15 entries
   (0 critical, 10 high, 5 moderate), all in the Prisma tooling tree according to
   `npm explain`. These are still installed dependencies, even though the HTTP
   service does not run Prisma Studio, its development server or MySQL. This is
   not a clean dependency-security sign-off. Do not apply npm's proposed Prisma
   6 downgrade or forced transitive overrides without a separate compatibility
   review of the Prisma 7 client/adapter and deployment generation path.
3. **Observe two complete nightly cycles before queue migration.** The migrated
   WebP pass and 15-minute schedule were exercised, but the full nightly cycle
   stability gate is not complete. Add alerting for missed runs, growing
   exhausted retries and service restarts; log rows alone are not an alert.
4. **Retain capacity and delivery caveats.** R2/READY inventories are still loaded
   as a complete set; paginate them before a substantial growth in image count.
   A SIGKILL can leave disk buffers for later cleanup. A crash after a paid model
   response but before its database write can repeat the provider call on retry.
   Claims prevent stale publication; they do not guarantee exactly-once billing.
   Systemd can still kill the worker on a memory spike. It contains the worker's
   memory use rather than guaranteeing that OOM is impossible.

Queueing, schedules, raw-image retention, image selection policy and production
model choices were not changed. Unrelated local geocoding scripts were preserved.
