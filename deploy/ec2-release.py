#!/usr/bin/python3
"""Install a main-branch revision without exposing application credentials."""

import datetime
import fcntl
import json
import os
import pwd
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

REPOSITORY = 'https://github.com/rs0125/procurement-enrichment.git'
BASE = Path('/opt/warehouse-enricher')
RELEASES = BASE / 'releases'
CURRENT = BASE / 'current'
PREVIOUS = BASE / 'previous'
ORIGINAL = Path('/opt/warehouse-geocoder-utility')
DROPIN = Path('/etc/systemd/system/warehouse-geocoder.service.d/enricher-release.conf')
CANARY = Path('/run/systemd/system/warehouse-enricher-canary.service')
UNIT = 'warehouse-geocoder.service'
SERVICES = {'geocode', 'proximity', 'image-label', 'document-kind', 'website-approval', 'webp', 'jpeg'}
RUNTIME_USER = 'warehouse-enricher'
BUILD_USER = 'warehouse-enricher-build'
STATE = '/var/lib/warehouse-enricher'
PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'


class DeploymentError(Exception):
    pass


def valid_revision(value):
    return bool(re.fullmatch(r'[0-9a-f]{40}', value))


def check_schedule(now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    minute = now.hour * 60 + now.minute
    if 21 * 60 + 15 <= minute < 22 * 60 + 45:
        raise DeploymentError('Nightly geocoding/backup window; rerun after 22:45 UTC')


def run(args, *, cwd=None, app_user=False, timeout=600):
    env = {'PATH': PATH, 'LANG': 'C.UTF-8', 'GIT_TERMINAL_PROMPT': '0'}
    if app_user:
        if cwd is None:
            raise DeploymentError('Build commands require an isolated working directory')
        args = ['systemd-run', '--wait', '--pipe', '--quiet', '--collect', '--service-type=exec',
                f'--property=User={BUILD_USER}', f'--property=Group={BUILD_USER}',
                '--property=NoNewPrivileges=true', '--property=CapabilityBoundingSet=',
                '--property=ProtectSystem=strict', '--property=ProtectHome=true', '--property=PrivateTmp=true',
                f'--property=WorkingDirectory={cwd}', f'--property=ReadWritePaths={cwd} /var/cache/warehouse-enricher',
                '--property=MemoryHigh=512M', '--property=MemoryMax=640M',
                '--property=TasksMax=128', '--property=CPUQuota=100%',
                f'--property=RuntimeMaxSec={int(timeout)}',
                '/usr/bin/env', '-i', f'PATH={PATH}', 'LANG=C.UTF-8', 'CI=true',
                'GIT_TERMINAL_PROMPT=0', 'npm_config_cache=/var/cache/warehouse-enricher',
                'NODE_OPTIONS=--max-old-space-size=384',
                'DATABASE_URL=postgresql://unused:unused@127.0.0.1:9/unused', *args]
    process = subprocess.Popen(args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, start_new_session=True)
    try:
        output, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise DeploymentError('Deployment command timed out') from None
    if process.returncode:
        log = BASE / 'last-command-failure.log'
        fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write(output)
        raise DeploymentError('Deployment command failed; details are in the private host log')
    return output.strip()


def ensure_accounts():
    for name in [RUNTIME_USER, BUILD_USER]:
        try:
            account = pwd.getpwnam(name)
        except KeyError:
            run(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent',
                 '--shell', '/usr/sbin/nologin', name])
            account = pwd.getpwnam(name)
        if account.pw_uid == 0 or account.pw_shell != '/usr/sbin/nologin' or set(os.getgrouplist(name, account.pw_gid)) != {account.pw_gid}:
            raise DeploymentError('Service account has unexpected privileges')


def runtime_protection():
    return f'''User={RUNTIME_USER}
Group={RUNTIME_USER}
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
UMask=0077
StateDirectory=warehouse-enricher
StateDirectoryMode=0750
Environment=ENRICHER_TEMP_DIR={STATE}/buffers
'''


def verify_runtime(unit):
    properties = dict(line.split('=', 1) for line in run(['systemctl', 'show', unit,
        '--property=User', '--property=NoNewPrivileges', '--property=CapabilityBoundingSet',
        '--property=ProtectSystem', '--property=ProtectHome']).splitlines())
    if properties != {'User': RUNTIME_USER, 'NoNewPrivileges': 'yes', 'CapabilityBoundingSet': '',
                      'ProtectSystem': 'strict', 'ProtectHome': 'yes'}:
        raise DeploymentError('Runtime privilege isolation did not become active')


def replace_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.next')
    temporary.write_text(text)
    temporary.chmod(0o644)
    temporary.replace(path)


def point(path, target):
    temporary = path.with_name(path.name + '.next')
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    temporary.replace(path)


def cron_secret():
    for line in Path('/etc/warehouse-geocoder.env').read_text().splitlines():
        if line.startswith('CRON_SECRET='):
            values = shlex.split(line.split('=', 1)[1])
            if len(values) == 1 and values[0]:
                return values[0]
    raise DeploymentError('Existing authentication configuration is missing')


def request(port, route, *, authenticated=False, method='GET'):
    headers = {'Connection': 'close'}
    if authenticated:
        headers['Authorization'] = 'Bearer ' + cron_secret()
    req = urllib.request.Request(f'http://127.0.0.1:{port}{route}', headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, None


def wait_database(port, *, attempts=30):
    for _ in range(attempts):
        try:
            code, body = request(port, '/health')
            if code == 200 and body.get('status') == 'ok' and body.get('db') == 'connected':
                break
        except (OSError, ValueError, AttributeError):
            pass
        time.sleep(1)
    else:
        raise DeploymentError('Database health check did not become ready')


def verify(port, *, attempts=30):
    wait_database(port, attempts=attempts)
    if request(port, '/enrichment')[0] != 401:
        raise DeploymentError('Enrichment authentication check failed')
    if request(port, '/cron/geocode-recent', method='POST')[0] != 401:
        raise DeploymentError('Existing geocoder authentication check failed')
    code, body = request(port, '/enrichment', authenticated=True)
    if code != 200 or not SERVICES.issubset({entry['name'] for entry in body.get('services', [])}):
        raise DeploymentError('Service registration check failed')


def prepare(revision):
    latest = run(['git', 'ls-remote', REPOSITORY, 'refs/heads/main'], timeout=60).split()[0]
    if latest != revision:
        raise DeploymentError('main has advanced; only the current main revision can deploy')
    release = RELEASES / revision
    if (release / '.release-ready').is_file():
        return release
    if release.exists():
        raise DeploymentError('Incomplete release exists; inspect it before retrying')
    if shutil.disk_usage(BASE).free < 2 * 1024**3:
        raise DeploymentError('Less than 2 GiB of free disk space')
    build = Path(tempfile.mkdtemp(prefix='.build-', dir=BASE))
    shutil.chown(build, user=BUILD_USER, group=BUILD_USER)
    source = build / 'source'
    try:
        print('Fetching the requested main revision', flush=True)
        run(['git', 'clone', '--depth=1', '--branch=main', REPOSITORY, str(source)], cwd=build, app_user=True)
        if run(['git', 'rev-parse', 'HEAD'], cwd=source, app_user=True) != revision:
            raise DeploymentError('main changed during fetch; no deployment performed')
        print('Installing dependencies and generating Prisma on ARM', flush=True)
        run(['npm', 'ci', '--omit=dev', '--no-audit', '--no-fund'], cwd=source, app_user=True)
        run(['npm', 'run', 'generate'], cwd=source, app_user=True)
        print('Running isolated application and native encoder tests', flush=True)
        tests = [str(path.relative_to(source)) for path in sorted((source / 'tests').glob('*.test.mjs'))]
        if not tests:
            raise DeploymentError('No release tests were found')
        run(['node', '--experimental-strip-types', '--test',
             *tests],
            cwd=source, app_user=True)
        (source / '.release-ready').write_text(revision + '\n')
        run(['chown', '-R', 'root:root', str(source)])
        source.rename(release)
        return release
    finally:
        shutil.rmtree(build)


def canary(release):
    if CANARY.exists():
        raise DeploymentError('An existing canary unit needs inspection')
    replace_text(CANARY, f'''[Unit]
Description=Warehouse enrichment deployment canary
[Service]
Type=simple
{runtime_protection()}WorkingDirectory={release}
EnvironmentFile=/etc/warehouse-geocoder.env
EnvironmentFile=-/etc/warehouse-enricher.env
Environment=MALLOC_ARENA_MAX=2
ExecStart=/usr/bin/env PORT=3001 /usr/bin/node --max-old-space-size=256 --experimental-strip-types src/index.mjs
MemoryHigh=320M
MemoryMax=384M
TasksMax=96
TimeoutStopSec=35
''')
    try:
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'start', CANARY.name])
        verify(3001)
        verify_runtime(CANARY.name)
    finally:
        run(['systemctl', 'stop', CANARY.name], timeout=45)
        CANARY.unlink(missing_ok=True)
        run(['systemctl', 'daemon-reload'])


def promote(release):
    previous = CURRENT.resolve() if CURRENT.exists() else ORIGINAL
    original_dropin = DROPIN.read_text() if DROPIN.exists() else None
    check_schedule()
    try:
        point(CURRENT, release)
        replace_text(DROPIN, f'''[Service]
{runtime_protection()}WorkingDirectory=/opt/warehouse-enricher/current
EnvironmentFile=-/etc/warehouse-enricher.env
Environment=MALLOC_ARENA_MAX=2
ExecStart=
ExecStart=/usr/bin/node --max-old-space-size=256 --experimental-strip-types src/index.mjs
MemoryHigh=640M
MemoryMax=768M
TasksMax=96
TimeoutStopSec=35
''')
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'restart', UNIT], timeout=60)
        verify(3000)
        verify_runtime(UNIT)
        pid = run(['systemctl', 'show', UNIT, '--property=MainPID', '--value'])
        if Path(f'/proc/{pid}/cwd').resolve() != release:
            raise DeploymentError('The running process does not use the requested release')
    except Exception:
        print('Deployment failed; restoring the previous service configuration', flush=True)
        point(CURRENT, previous)
        if original_dropin is None:
            DROPIN.unlink(missing_ok=True)
        else:
            replace_text(DROPIN, original_dropin)
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'restart', UNIT], timeout=60)
        # The original geocoder predates the enrichment catalog endpoint.
        try:
            wait_database(3000)
        except Exception:
            raise DeploymentError('Rollback health failed; inspect the host immediately') from None
        raise DeploymentError('New release failed verification; previous release restored') from None
    point(PREVIOUS, previous)


def deploy(revision):
    if not valid_revision(revision):
        raise DeploymentError('A full lowercase Git commit SHA is required')
    check_schedule()
    RELEASES.mkdir(parents=True, exist_ok=True)
    ensure_accounts()
    cache = Path('/var/cache/warehouse-enricher')
    cache.mkdir(mode=0o750, exist_ok=True)
    run(['chown', '-R', f'{BUILD_USER}:{BUILD_USER}', str(cache)])
    release = prepare(revision)
    if CURRENT.exists() and CURRENT.resolve() == release:
        verify(3000)
        verify_runtime(UNIT)
        print(json.dumps({'status': 'already_current', 'revision': revision, 'service': UNIT}), flush=True)
        return
    print('Checking the new release on localhost:3001', flush=True)
    canary(release)
    print('Promoting the release to the existing geocoder unit', flush=True)
    promote(release)
    keep = {CURRENT.resolve(), PREVIOUS.resolve()}
    candidates = sorted((p for p in RELEASES.iterdir() if p.is_dir() and not p.is_symlink()
                         and valid_revision(p.name) and (p / '.release-ready').is_file()),
                        key=lambda p: p.stat().st_mtime, reverse=True)
    keep.update(candidates[:3])
    for old in candidates:
        if old not in keep:
            shutil.rmtree(old)
    print(json.dumps({'status': 'deployed', 'revision': revision, 'service': UNIT}), flush=True)


if __name__ == '__main__':
    try:
        if os.geteuid() != 0 or len(sys.argv) != 2:
            raise DeploymentError('Run as root with one commit SHA')
        with open('/run/lock/warehouse-enricher-deploy.lock', 'w') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise DeploymentError('Another deployment is already running') from None
            deploy(sys.argv[1])
    except DeploymentError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('Deployment failed; inspect the host without publishing private logs', file=sys.stderr)
        sys.exit(1)
