"""Disposable-container experiment only. Stops this fixture's Postgres with SIGKILL.

Not a production backup implementation: the JSON snapshot is bounded fixture data,
and does not export roles, grants, domain data, or a fleet-wide consistent snapshot.
"""
import json
import os
import tempfile
from pathlib import Path
import subprocess
import time

ROOT = Path(os.environ.get('PGMQ_EVAL_OUTPUT') or tempfile.mkdtemp(prefix='enricher-pgmq-backup-'))
ROOT.mkdir(parents=True, exist_ok=True)
CONTAINER = 'enricher-pgmq-eval'
VOLUME = 'enricher-pgmq-eval-data'
DATABASES = [('1.5.1', 'enricher_pgmq_test'), ('1.13.0', 'enricher_pgmq_latest_test')]


def run(arguments, data=None):
    result = subprocess.run(arguments, input=data, capture_output=True,
                            text=True, timeout=45)
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return result.stdout.strip()


def sql(database, statement):
    assert database in {db for _, db in DATABASES} | {
        'enricher_pgmq_restore_test', 'enricher_pgmq_latest_restore_test'}
    return run(['podman', 'exec', '-i', CONTAINER, 'psql', '-XqAt', '-U', 'pgmq_test',
                '-d', database, '-v', 'ON_ERROR_STOP=1'], statement)


inspection = json.loads(run(['podman', 'inspect', CONTAINER]))[0]
assert inspection['Name'].lstrip('/') == CONTAINER
assert inspection['Config']['Image'] == 'docker.io/library/postgres:17'
assert any(mount.get('Name') == VOLUME for mount in inspection['Mounts'])
assert 'POSTGRES_DB=enricher_pgmq_test' in inspection['Config']['Env']

report = []
for restore_name in ['enricher_pgmq_restore_test', 'enricher_pgmq_latest_restore_test']:
    run(['podman', 'exec', CONTAINER, 'dropdb', '-U', 'pgmq_test', '--if-exists', restore_name])
for version, database in DATABASES:
    assert sql(database, "SELECT extversion FROM pg_extension WHERE extname='pgmq'") == version
    sql(database, """SELECT pgmq.drop_queue('enrich_backup'); SELECT pgmq.create('enrich_backup');
        SELECT pgmq.send('enrich_backup', '{"action":"webp","subjectId":"1"}');
        SELECT pgmq.send('enrich_backup', '{"action":"jpeg","subjectId":"2"}');
        SELECT pgmq.archive('enrich_backup',1::bigint);""")
    assert sql(database, 'SELECT count(*) FROM pgmq.q_enrich_backup') == '1'
    receipt = json.loads(sql(database, "SELECT row_to_json(r) FROM pgmq.read('enrich_backup', 1, 1) r"))
    assert receipt['msg_id'] == 2
    report.append({'version': version, 'beforeCrashReceipt': receipt['read_ct']})

run(['podman', 'kill', '--signal', 'KILL', CONTAINER])
run(['podman', 'start', CONTAINER])
ready = False
for _ in range(40):
    attempt = subprocess.run(['podman', 'exec', CONTAINER, 'pg_isready', '-U', 'pgmq_test'],
                             capture_output=True, timeout=3)
    if attempt.returncode == 0:
        ready = True
        break
    time.sleep(0.25)
assert ready, 'Local Postgres failed to restart'
time.sleep(1.1)

for entry, (version, database) in zip(report, DATABASES):
    recovered = json.loads(sql(database, "SELECT row_to_json(r) FROM pgmq.read('enrich_backup', 60, 1) r"))
    assert recovered['msg_id'] == 2
    assert recovered['read_ct'] == entry['beforeCrashReceipt'] + 1
    assert sql(database, 'SELECT count(*) FROM pgmq.a_enrich_backup') == '1'
    entry['crashRecovery'] = 'PASS: pending and archived data retained; unacked ID redelivered'

# Explicit, version-pinned snapshot/restore for 1.5.1. This proves a path exists;
# production must stream/bound data, include permissions and share the domain snapshot.
snapshot = json.loads(sql('enricher_pgmq_test', '''
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT jsonb_build_object(
  'meta', (SELECT jsonb_agg(to_jsonb(m)) FROM pgmq.meta m),
  'pending', (SELECT jsonb_agg(to_jsonb(q)) FROM pgmq.q_enrich_backup q),
  'archive', (SELECT jsonb_agg(to_jsonb(a)) FROM pgmq.a_enrich_backup a),
  'sequence', (SELECT jsonb_build_object('last_value',last_value,'is_called',is_called)
               FROM pgmq.q_enrich_backup_msg_id_seq));
COMMIT;
'''))
(ROOT / 'backup-1.5.1-fixture-snapshot.json').write_text(json.dumps(snapshot, indent=2) + '\n')
restore_db = 'enricher_pgmq_restore_test'
run(['podman', 'exec', CONTAINER, 'createdb', '-U', 'pgmq_test', restore_db])
restore = ["BEGIN; CREATE EXTENSION pgmq VERSION '1.5.1';",
           "SELECT pgmq.create('enrich_backup'); TRUNCATE pgmq.meta;"]
for key, relation in [('meta', 'meta'), ('pending', 'q_enrich_backup'), ('archive', 'a_enrich_backup')]:
    payload = json.dumps(snapshot[key])
    assert '$fixture$' not in payload
    override = ' OVERRIDING SYSTEM VALUE' if key == 'pending' else ''
    restore.append(f'INSERT INTO pgmq.{relation}{override} SELECT * FROM '
                   f'jsonb_populate_recordset(NULL::pgmq.{relation}, $fixture${payload}$fixture$::jsonb);')
sequence = snapshot['sequence']
assert isinstance(sequence['last_value'], int) and isinstance(sequence['is_called'], bool)
restore.append("SELECT setval('pgmq.q_enrich_backup_msg_id_seq', " +
               str(sequence['last_value']) + ', ' + str(sequence['is_called']).lower() + '); COMMIT;')
sql(restore_db, '\n'.join(restore))
for key, relation in [('meta', 'meta'), ('pending', 'q_enrich_backup'), ('archive', 'a_enrich_backup')]:
    restored = json.loads(sql(restore_db, f'SELECT jsonb_agg(to_jsonb(t)) FROM pgmq.{relation} t'))
    assert restored == snapshot[key], (key, restored)
expected_next = sequence['last_value'] + (1 if sequence['is_called'] else 0)
assert int(sql(restore_db, "SELECT pgmq.send('enrich_backup', '{}'::jsonb)")) == expected_next
report[0]['explicitFixtureRestore'] = 'PASS: metadata, pending/archive fields, and next ID preserved'

# New version: ordinary extension-aware dump includes data, metadata and sequence.
dump = run(['podman', 'exec', CONTAINER, 'pg_dump', '-U', 'pgmq_test',
            '-d', 'enricher_pgmq_latest_test', '--no-owner', '--no-privileges',
            '--schema=pgmq', '--extension=pgmq'])
assert 'COPY pgmq.q_enrich_backup' in dump and 'COPY pgmq.meta' in dump
assert 'CREATE EXTENSION IF NOT EXISTS pgmq WITH SCHEMA pgmq;' in dump
# pg_dump does not pin extension versions; explicitly pin in this isolated restore.
dump = dump.replace('CREATE EXTENSION IF NOT EXISTS pgmq WITH SCHEMA pgmq;',
                    "CREATE EXTENSION IF NOT EXISTS pgmq WITH SCHEMA pgmq VERSION '1.13.0';")
(ROOT / 'backup-1.13.0-restored.sql').write_text(dump + '\n')
latest_restore = 'enricher_pgmq_latest_restore_test'
run(['podman', 'exec', CONTAINER, 'createdb', '-U', 'pgmq_test', latest_restore])
sql(latest_restore, dump)
for relation in ['meta', 'q_enrich_backup', 'a_enrich_backup']:
    query = f'SELECT jsonb_agg(to_jsonb(t)) FROM pgmq.{relation} t'
    assert json.loads(sql(latest_restore, query)) == json.loads(sql('enricher_pgmq_latest_test', query))
latest_sequence = json.loads(sql('enricher_pgmq_latest_test',
    "SELECT jsonb_build_object('last_value',last_value,'is_called',is_called) FROM pgmq.q_enrich_backup_msg_id_seq"))
expected_latest_next = latest_sequence['last_value'] + (1 if latest_sequence['is_called'] else 0)
assert int(sql(latest_restore, "SELECT pgmq.send('enrich_backup', '{}'::jsonb)")) == expected_latest_next
report[1]['extensionAwareDumpRestore'] = 'PASS: metadata, pending/archive fields, and next ID preserved'

(ROOT / 'durability-backup-results.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
