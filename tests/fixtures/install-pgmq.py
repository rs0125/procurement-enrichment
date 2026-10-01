"""Install pinned PGMQ SQL files ONLY into the named disposable test container.

No application credentials; validates fixture POSTGRES_DB before copying files.
Usage: python3 tests/fixtures/install-pgmq.py --engine podman --container NAME
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--engine', choices=['docker', 'podman'], required=True)
parser.add_argument('--container', required=True)
args = parser.parse_args()
inspection = json.loads(subprocess.check_output([args.engine, 'inspect', args.container], text=True))[0]
assert 'POSTGRES_DB=enricher_test' in inspection['Config']['Env'], 'Fixture database required'
assert 'POSTGRES_USER=postgres' in inspection['Config']['Env'], 'Fixture role required'
url = 'https://raw.githubusercontent.com/pgmq/pgmq/7fd411d8ffd53b5313039f59167124c861d46430/pgmq-extension/sql/pgmq.sql'
with urllib.request.urlopen(url, timeout=30) as response:
    sql = response.read(100000)
assert hashlib.sha256(sql).hexdigest() == '65b9302faa660539584769a572b57f2df76ccf1b3a2153c37cefc57b8db633e9'
with tempfile.TemporaryDirectory(prefix='enricher-pgmq-files-') as temporary:
    root = Path(temporary)
    (root / 'pgmq--1.5.1.sql').write_bytes(sql)
    (root / 'pgmq.control').write_text("comment = 'Pinned PGMQ local fixture'\ndefault_version = '1.5.1'\nschema = 'pgmq'\nrelocatable = false\nsuperuser = false\n")
    for name in ['pgmq--1.5.1.sql', 'pgmq.control']:
        subprocess.run([args.engine, 'cp', str(root/name), args.container + ':/usr/share/postgresql/17/extension/' + name], check=True)
# Cluster roles are shared across the two independently tested databases.
subprocess.run([args.engine, 'exec', args.container, 'psql', '-U', 'postgres', '-d', 'enricher_test', '-v', 'ON_ERROR_STOP=1', '-c', "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='enrichment_queue_worker') THEN CREATE ROLE enrichment_queue_worker NOLOGIN; END IF; END $$"], check=True, capture_output=True)
print('Pinned PGMQ 1.5.1 fixture files installed.')
