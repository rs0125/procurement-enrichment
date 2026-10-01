# Local PGMQ compatibility experiment

These are opt-in fixture tests, outside `npm test`. See the
[evaluation](../../docs/PGMQ_EVALUATION.md) and [recorded results](results.json).
No application runtime, dependency, production schema or deployment is changed.

Run from the repository root with its existing Node dependencies installed.
Requires Node 22+, Python 3, Git and Podman. Tests use a dedicated local PostgreSQL
container limited to 512 MiB and one CPU. The password below is a disposable
fixture value, not an application secret. Never load the production `.env`.

## Prepare a fresh local database

The names `enricher-pgmq-eval` and `enricher-pgmq-eval-data` must be unused. Do not
reuse a pre-existing database or remove containers belonging to other work.

```bash
PGMQ_EVAL_DIR=$(mktemp -d /tmp/enricher-pgmq.XXXXXX)
export PGMQ_EVAL_OUTPUT="$PGMQ_EVAL_DIR/results"
git clone --depth 1 --branch v1.13.0 https://github.com/pgmq/pgmq.git "$PGMQ_EVAL_DIR/upstream"
git -C "$PGMQ_EVAL_DIR/upstream" fetch --depth 1 origin tag v1.5.1
git -C "$PGMQ_EVAL_DIR/upstream" show v1.5.1:pgmq-extension/pgmq.control > "$PGMQ_EVAL_DIR/pgmq.control"
git -C "$PGMQ_EVAL_DIR/upstream" show v1.5.1:pgmq-extension/sql/pgmq.sql > "$PGMQ_EVAL_DIR/pgmq--1.5.1.sql"
git -C "$PGMQ_EVAL_DIR/upstream" show v1.13.0:pgmq-extension/sql/pgmq.sql > "$PGMQ_EVAL_DIR/pgmq--1.13.0.sql"
sha256sum "$PGMQ_EVAL_DIR"/pgmq--*.sql
```

Before installing, compare the SQL hashes with `sources` in `results.json`:

| Version | Commit | SQL SHA-256 |
|---|---|---|
| 1.5.1 | `7fd411d8ffd53b5313039f59167124c861d46430` | `65b9302faa660539584769a572b57f2df76ccf1b3a2153c37cefc57b8db633e9` |
| 1.13.0 | `32c075bb6dbed66a303d1a792393c93e36c09a97` | `bf7e66c75ed771df0c5f7cb2b9f0123ca77992daacd56e3911d1894a3efa99de` |

The official extension is SQL/PLpgSQL. This installs its versioned script in a
disposable PostgreSQL image, using the same file layout as its Makefile.

```bash
podman run --detach --name enricher-pgmq-eval \
  --memory=512m --cpus=1 --pids-limit=128 \
  --volume enricher-pgmq-eval-data:/var/lib/postgresql/data \
  -e POSTGRES_USER=pgmq_test -e POSTGRES_PASSWORD=pgmq-local-fixture \
  -e POSTGRES_DB=enricher_pgmq_test \
  -p 127.0.0.1:55441:5432 docker.io/library/postgres:17
podman exec enricher-pgmq-eval pg_isready -U pgmq_test
```

Wait for readiness before continuing. A pre-existing container or occupied port
should stop setup; do not fall back to a remote database.

```bash
podman cp "$PGMQ_EVAL_DIR/pgmq.control" enricher-pgmq-eval:/usr/share/postgresql/17/extension/
podman cp "$PGMQ_EVAL_DIR/pgmq--1.5.1.sql" enricher-pgmq-eval:/usr/share/postgresql/17/extension/
podman cp "$PGMQ_EVAL_DIR/pgmq--1.13.0.sql" enricher-pgmq-eval:/usr/share/postgresql/17/extension/
podman exec enricher-pgmq-eval psql -U pgmq_test -d enricher_pgmq_test -v ON_ERROR_STOP=1 -c "CREATE EXTENSION pgmq VERSION '1.5.1'"
podman exec enricher-pgmq-eval createdb -U pgmq_test enricher_pgmq_latest_test
podman exec enricher-pgmq-eval psql -U pgmq_test -d enricher_pgmq_latest_test -v ON_ERROR_STOP=1 -c "CREATE EXTENSION pgmq VERSION '1.13.0'"
```

## Run the contract and fault checks

The Node suite requires localhost, port 55441, and one of the two explicit test
database names. It tests primitives and a receipt-guard sketch, not the deployed
enrichment handlers. The duplicate/result cases simulate a provider effect; real
action claims and source-versus-trigger races remain integration requirements.

```bash
PGMQ_EXPECTED_VERSION=1.5.1 \
PGMQ_TEST_DATABASE_URL=postgresql://pgmq_test:pgmq-local-fixture@127.0.0.1:55441/enricher_pgmq_test \
node --test experiments/pgmq/contract.test.mjs

PGMQ_EXPECTED_VERSION=1.13.0 \
PGMQ_TEST_DATABASE_URL=postgresql://pgmq_test:pgmq-local-fixture@127.0.0.1:55441/enricher_pgmq_latest_test \
node --test experiments/pgmq/contract.test.mjs

python3 experiments/pgmq/dump-inspection.py
python3 experiments/pgmq/durability-backup.py
```

Run the two versions sequentially because a fixture role is cluster-wide.
The dump check asserts the version-specific omissions and writes fixture SQL.
The durability script intentionally **SIGKILLs this test container**, restarts it,
and recreates only its two named restore databases. It verifies redelivery,
pending/archive data, metadata and sequence state. It expects the fixture queue
from the dump check. Crash recovery can leave gaps in sequence values; the test
checks the restored sequence, not consecutive IDs.

The 1.5.1 JSON export is for small fixtures only, not a production backup tool.
It does not stream large queues, restore grants, or synchronize its snapshot with
warehouse data. The 1.13.0 restore pins its extension version explicitly because
an ordinary `pg_dump` extension declaration does not pin it for us.

Results go to `PGMQ_EVAL_OUTPUT`, or a fresh temporary directory if omitted.
There are no provider calls or R2 accesses. Local timing is not a production
capacity benchmark. Supabase's actual roles and extension packaging still need
a separate staging integration check.

## Remove only these disposable resources

```bash
podman rm --force enricher-pgmq-eval
podman volume rm enricher-pgmq-eval-data
```

Keep the small local result files for review as needed. These tests do not enable
PGMQ or change anything in the shared Supabase project.
