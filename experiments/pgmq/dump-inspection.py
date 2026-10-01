"""Inspect local PGMQ fixture dumps. No production credentials or connections."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(os.environ.get('PGMQ_EVAL_OUTPUT') or tempfile.mkdtemp(prefix='enricher-pgmq-dump-'))
root.mkdir(parents=True, exist_ok=True)
container = 'enricher-pgmq-eval'
inspection = json.loads(subprocess.check_output(['podman', 'inspect', container], text=True))[0]
assert inspection['Name'].lstrip('/') == container
assert inspection['Config']['Image'] == 'docker.io/library/postgres:17'
assert 'POSTGRES_DB=enricher_pgmq_test' in inspection['Config']['Env']
results = []
for version, database in [('1.5.1', 'enricher_pgmq_test'), ('1.13.0', 'enricher_pgmq_latest_test')]:
    base = ['podman', 'exec', container]

    def sql(statement):
        return subprocess.run(base + ['psql', '-XqAt', '-U', 'pgmq_test', '-d', database,
            '-v', 'ON_ERROR_STOP=1', '-c', statement], check=True, capture_output=True,
            text=True, timeout=30).stdout.strip()

    assert sql("SELECT extversion FROM pg_extension WHERE extname='pgmq'") == version
    sql("""SELECT pgmq.create('enrich_backup');
        SELECT pgmq.send('enrich_backup', '{"action":"webp","subjectId":"1"}');
        SELECT pgmq.send('enrich_backup', '{"action":"jpeg","subjectId":"2"}');
        SELECT pgmq.archive('enrich_backup',1::bigint);""")
    modes = [
        ('public-only', ['--schema=public']),
        ('add-pgmq', ['--schema=public', '--schema=pgmq']),
        ('explicit-extension', ['--schema=pgmq', '--extension=pgmq']),
        ('explicit-data', ['--data-only', '--table=pgmq.q_enrich_backup',
                           '--table=pgmq.a_enrich_backup', '--table=pgmq.meta']),
    ]
    for label, flags in modes:
        result = subprocess.run(base + ['pg_dump', '-U', 'pgmq_test', '-d', database,
            '--no-owner', '--no-privileges'] + flags, check=True, capture_output=True,
            text=True, timeout=30)
        (root / f'dump-{version}-{label}.sql').write_text(result.stdout)
        entry = {'version': version, 'mode': label,
            'queueDDL': 'CREATE TABLE pgmq.q_enrich_backup' in result.stdout,
            'pendingData': 'COPY pgmq.q_enrich_backup' in result.stdout,
            'archiveData': 'COPY pgmq.a_enrich_backup' in result.stdout,
            'metadataData': 'COPY pgmq.meta' in result.stdout,
            'bytes': len(result.stdout)}
        results.append(entry)
        print(json.dumps(entry))
        expected = version == '1.13.0' and label != 'public-only'
        assert entry['pendingData'] == expected
        assert entry['archiveData'] == expected
        assert entry['metadataData'] == expected
(root / 'dump-inspection.json').write_text(json.dumps(results, indent=2) + '\n')
