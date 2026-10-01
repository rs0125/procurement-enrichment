"""Run PostgreSQL client tools inside the disposable backup-test container."""
import json
from pathlib import Path
import subprocess
import sys
import uuid

engine, container, database, tool, *args = sys.argv[1:]
assert engine in ('docker', 'podman')
assert database in ('enricher_backup_test', 'enricher_restore_test')
assert tool in ('psql', 'pg_dump', 'pg_restore')
config = json.loads(subprocess.check_output([engine, 'inspect', container], text=True))[0]['Config']['Env']
assert 'POSTGRES_DB=enricher_test' in config and 'POSTGRES_USER=postgres' in config
copied = []
try:
    for index, arg in enumerate(args):
        if arg.startswith('--use-list='):
            source = Path(arg.split('=', 1)[1])
            assert source.name == 'selected.list' and source.stat().st_size < 4 * 1024 * 1024
            destination = '/tmp/enricher-restore-' + uuid.uuid4().hex + '.list'
            subprocess.run([engine, 'cp', str(source), container + ':' + destination], check=True, stdout=subprocess.DEVNULL)
            copied.append(destination)
            args[index] = '--use-list=' + destination
    result = subprocess.run([engine, 'exec', '-i', container, 'env', 'PGUSER=postgres', 'PGDATABASE=' + database, tool, *args],
                            stdin=sys.stdin.buffer, stdout=sys.stdout.buffer, stderr=sys.stderr.buffer)
finally:
    for path in copied:
        subprocess.run([engine, 'exec', container, 'rm', '-f', path], check=True)
raise SystemExit(result.returncode)
