#!/usr/bin/env python3
"""Trigger the fixed deployment command; never publish remote command output."""

import json
import re
import subprocess
import sys
import time

INSTANCE = 'i-0c32bf6ffaca045f1'
REGION = 'ap-south-1'
DOCUMENT = 'WarehouseEnricher-Deploy'


class DeploymentError(Exception):
    pass


def aws(*args, missing_ok=False):
    result = subprocess.run(['aws', 'ssm', *args, '--region', REGION, '--output', 'json',
                             '--no-cli-pager', '--cli-connect-timeout', '10', '--cli-read-timeout', '30'],
                            text=True, capture_output=True, timeout=90)
    if result.returncode:
        if missing_ok and 'InvocationDoesNotExist' in result.stderr:
            return None
        raise DeploymentError('AWS command failed; private diagnostics are not copied to Actions logs')
    return json.loads(result.stdout)


def deploy(revision):
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise DeploymentError('A full lowercase commit SHA is required')
    command = aws('send-command', '--document-name', DOCUMENT, '--document-version', '1',
                  '--instance-ids', INSTANCE, '--parameters', json.dumps({'Commit': [revision]}),
                  '--timeout-seconds', '60', '--comment', 'GitHub deploy ' + revision)
    command_id = command['Command']['CommandId']
    print('Deployment command submitted: ' + command_id, flush=True)
    deadline = time.monotonic() + 1230
    last_status = None
    while time.monotonic() < deadline:
        result = aws('get-command-invocation', '--command-id', command_id, '--instance-id', INSTANCE,
                     missing_ok=True)
        status = result['Status'] if result else 'Pending'
        if status != last_status:
            print('Deployment status: ' + status, flush=True)
            last_status = status
        if status == 'Success':
            print('Deployed and health-checked revision ' + revision, flush=True)
            return
        if status not in {'Pending', 'InProgress', 'Delayed'}:
            raise DeploymentError('Deployment did not succeed. Inspect the private host logs; rerun CI after resolving it.')
        time.sleep(5)
    raise DeploymentError('Deployment result timed out; inspect the instance before retrying')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise DeploymentError('Exactly one commit SHA is required')
        deploy(sys.argv[1])
    except DeploymentError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('Deployment failed; private diagnostics are not copied to Actions logs', file=sys.stderr)
        sys.exit(1)
