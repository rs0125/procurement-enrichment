import datetime
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('ec2_release', Path(__file__).parents[1] / 'deploy/ec2-release.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentTests(unittest.TestCase):
    def test_build_commands_have_a_whole_process_memory_and_runtime_cap(self):
        process = Mock(returncode=0)
        process.communicate.return_value = ('ok\n', None)
        with patch.object(deploy.subprocess, 'Popen', return_value=process) as popen:
            self.assertEqual(deploy.run(['npm', 'ci'], cwd=Path('/isolated/build'), app_user=True, timeout=60), 'ok')
        command = popen.call_args.args[0]
        self.assertEqual(command[:3], ['systemd-run', '--wait', '--pipe'])
        for flag in ['--property=User=warehouse-enricher-build', '--property=NoNewPrivileges=true', '--property=ProtectSystem=strict', '--property=ProtectHome=true', '--property=CapabilityBoundingSet=']:
            self.assertIn(flag, command)
        for flag in ['--property=MemoryMax=640M', '--property=TasksMax=128', '--property=RuntimeMaxSec=60']:
            self.assertIn(flag, command)
        self.assertIn('NODE_OPTIONS=--max-old-space-size=384', command)
        self.assertEqual(command[-2:], ['npm', 'ci'])
        self.assertEqual(set(popen.call_args.kwargs['env']), {'PATH', 'LANG', 'GIT_TERMINAL_PROMPT'})

    def test_only_full_commit_ids_are_accepted(self):
        self.assertTrue(deploy.valid_revision('f' * 40))
        for value in ['main', 'f' * 39, 'F' * 40, 'f' * 40 + ';id', '../main']:
            self.assertFalse(deploy.valid_revision(value))

    def test_nightly_jobs_are_protected(self):
        for hour, minute in [(21, 15), (21, 27), (22, 30), (22, 44)]:
            with self.assertRaises(deploy.DeploymentError):
                deploy.check_schedule(datetime.datetime(2026, 9, 26, hour, minute, tzinfo=datetime.timezone.utc))
        for hour, minute in [(21, 14), (22, 45), (0, 0)]:
            deploy.check_schedule(datetime.datetime(2026, 9, 26, hour, minute, tzinfo=datetime.timezone.utc))

    def test_canary_does_not_reserve_a_second_production_sized_memory_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            unit = Path(folder) / 'canary.service'
            contents = []
            with patch.object(deploy, 'CANARY', unit), patch.object(deploy, 'run', return_value=''), patch.object(deploy, 'verify', side_effect=lambda port: contents.append(unit.read_text())), patch.object(deploy, 'verify_runtime') as protection:
                deploy.canary(Path(folder))
            protection.assert_called_once_with(unit.name)
            self.assertIn('User=warehouse-enricher\n', contents[0])
            self.assertIn('NoNewPrivileges=true', contents[0])
            self.assertIn('ProtectSystem=strict', contents[0])
            self.assertIn('StateDirectory=warehouse-enricher', contents[0])
            self.assertIn('MemoryMax=384M', contents[0])
            self.assertIn('MemoryHigh=320M', contents[0])
            self.assertIn('PORT=3001 ENRICHMENT_PROCESS_ROLE=api', contents[0])
            self.assertFalse(unit.exists())

    def test_rollback_waits_for_the_previous_process_to_start(self):
        with patch.object(deploy, 'request', side_effect=[ConnectionRefusedError(), (503, None), (200, {'status': 'ok', 'db': 'connected'})]), patch.object(deploy.time, 'sleep'):
            deploy.wait_database(3000, attempts=3)

    def test_failed_promotion_restores_previous_release_and_configuration(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            current = root / 'current'
            previous = root / 'old'
            candidate = root / 'new'
            previous.mkdir(); candidate.mkdir(); current.symlink_to(previous)
            dropin = root / 'unit.conf'
            dropin.write_text('[Service]\nWorkingDirectory=/old\n')
            with patch.multiple(deploy, CURRENT=current, DROPIN=dropin, PREVIOUS=root/'previous'), patch.object(deploy, 'run', return_value='') as run, patch.object(deploy, 'check_schedule'), patch.object(deploy, 'verify', side_effect=deploy.DeploymentError('canary regression')), patch.object(deploy, 'wait_database') as ready:
                with self.assertRaisesRegex(deploy.DeploymentError, 'previous release restored'):
                    deploy.promote(candidate)
                self.assertEqual(current.resolve(), previous)
                self.assertEqual(dropin.read_text(), '[Service]\nWorkingDirectory=/old\n')
                ready.assert_called_once_with(3000)
                self.assertEqual(sum(call.args[0] == ['systemctl', 'restart', deploy.UNIT] for call in run.call_args_list), 2)

    def test_first_deployment_failure_restores_the_original_unit(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            original = root / 'original'; original.mkdir()
            candidate = root / 'new'; candidate.mkdir()
            dropin = root / 'unit.conf'
            with patch.multiple(deploy, CURRENT=root/'current', DROPIN=dropin, ORIGINAL=original), patch.object(deploy, 'run', return_value=''), patch.object(deploy, 'check_schedule'), patch.object(deploy, 'verify', side_effect=deploy.DeploymentError('failed health')), patch.object(deploy, 'wait_database'):
                with self.assertRaisesRegex(deploy.DeploymentError, 'previous release restored'):
                    deploy.promote(candidate)
                self.assertFalse(dropin.exists())
                self.assertEqual((root/'current').resolve(), original)

    def test_already_current_does_not_restart_or_replace_rollback_target(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            release = root / ('f' * 40); release.mkdir()
            current = root / 'current'; current.symlink_to(release)
            with patch.multiple(deploy, CURRENT=current, RELEASES=root), patch.object(deploy, 'check_schedule'), patch.object(deploy, 'prepare', return_value=release), patch.object(deploy, 'ensure_accounts'), patch.object(deploy, 'run'), patch.object(deploy, 'verify_runtime'), patch.object(deploy.shutil, 'chown'), patch.object(deploy.Path, 'mkdir'), patch.object(deploy, 'verify') as verify, patch.object(deploy, 'promote') as promote:
                deploy.deploy('f' * 40)
                verify.assert_called_once_with(3000)
                promote.assert_not_called()

    def test_runtime_verification_rejects_privilege_regressions(self):
        good = 'User=warehouse-enricher\nNoNewPrivileges=yes\nCapabilityBoundingSet=\nProtectSystem=strict\nProtectHome=yes'
        with patch.object(deploy, 'run', return_value=good):
            deploy.verify_runtime('test.service')
        for bad in [good.replace('User=warehouse-enricher', 'User=ubuntu'), good.replace('NoNewPrivileges=yes','NoNewPrivileges=no'), good.replace('CapabilityBoundingSet=', 'CapabilityBoundingSet=cap_setuid')]:
            with patch.object(deploy, 'run', return_value=bad), self.assertRaises(deploy.DeploymentError):
                deploy.verify_runtime('test.service')

    def test_service_accounts_cannot_be_privileged_existing_accounts(self):
        for uid, shell, groups in [(0, '/usr/sbin/nologin', [50]), (500, '/bin/bash', [50]), (500, '/usr/sbin/nologin', [50, 27])]:
            with patch.object(deploy.pwd, 'getpwnam', return_value=Mock(pw_uid=uid, pw_gid=50, pw_shell=shell)), patch.object(deploy.os, 'getgrouplist', return_value=groups), self.assertRaises(deploy.DeploymentError):
                deploy.ensure_accounts()

    def test_isolated_build_requires_a_working_directory(self):
        with self.assertRaises(deploy.DeploymentError):
            deploy.run(['npm','ci'], app_user=True)

    def test_backup_installation_requires_verified_nonroot_units_before_copying_code(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'release/deploy/backup'; source.mkdir(parents=True)
            for name in ['run.mjs', 'snapshot.mjs', 'backup.sh']:
                (source / name).write_text('fixture')
            calls = []
            def run(args):
                calls.append(args)
                return 'inactive' if 'ActiveState' in ' '.join(args) else ''
            def verify(unit):
                contents = (root / 'units' / (unit + '.d') / 'enricher-backup.conf').read_text()
                for expected in ['User=warehouse-enricher-backup', 'Group=warehouse-enricher-backup',
                                 'NoNewPrivileges=true', 'CapabilityBoundingSet=\n', 'MemoryMax=384M',
                                 'ReadWritePaths=\n', 'ExecStart=/usr/bin/env BACKUP_DIR=']:
                    self.assertIn(expected, contents)
                self.assertFalse(any(command[0] == 'install' for command in calls))
            with patch.multiple(deploy, BACKUP_BASE=root/'helpers', BACKUP_DIRECTORY=root/'data', SYSTEM_UNITS=root/'units'), patch.object(deploy, 'run', side_effect=run), patch.object(deploy, 'verify_backup', side_effect=verify) as check:
                deploy.install_backup(root/'release')
            self.assertEqual(check.call_count, 2)
            self.assertTrue(any(command[0] == 'install' for command in calls))

    def test_backup_installation_refuses_an_active_backup_or_incomplete_release(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'release/deploy/backup'; source.mkdir(parents=True)
            (source/'run.mjs').write_text('fixture')
            with patch.object(deploy, 'run') as run:
                with self.assertRaisesRegex(deploy.DeploymentError, 'Incomplete'):
                    deploy.install_backup(root/'release')
                run.assert_not_called()
            (source/'snapshot.mjs').write_text('fixture')
            (source/'backup.sh').write_text('fixture')
            with patch.object(deploy, 'run', return_value='activating') as run, patch.object(deploy, 'replace_text') as replace:
                with self.assertRaisesRegex(deploy.DeploymentError, 'is active'):
                    deploy.install_backup(root/'release')
                self.assertEqual(run.call_count, 1)
                replace.assert_not_called()

    def test_older_application_keeps_the_installed_queue_backup(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            installed = root / 'helpers'; installed.mkdir()
            for name in ['run.mjs','snapshot.mjs']:
                (installed/name).write_text('queue format')
            with patch.object(deploy, 'BACKUP_BASE', installed), patch.object(deploy, 'run') as run:
                deploy.install_backup(root/'older-release')
                run.assert_not_called()
            for name in ['run.mjs','snapshot.mjs']:
                self.assertEqual((installed/name).read_text(), 'queue format')

    def test_backup_installation_rejects_release_symlinks_to_host_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'release/deploy/backup'; source.mkdir(parents=True)
            (root/'private-host-file').write_text('fixture private data')
            (source/'snapshot.mjs').write_text('fixture')
            (source/'backup.sh').write_text('fixture')
            (source/'run.mjs').symlink_to(root/'private-host-file')
            with patch.object(deploy, 'run') as run:
                with self.assertRaisesRegex(deploy.DeploymentError, 'regular files inside the release'):
                    deploy.install_backup(root/'release')
                run.assert_not_called()
            (source/'run.mjs').unlink()
            (source/'run.mjs').write_text('fixture')
            source.rename(root/'external-sources')
            source.symlink_to(root/'external-sources', target_is_directory=True)
            with patch.object(deploy, 'run') as run:
                with self.assertRaisesRegex(deploy.DeploymentError, 'regular files inside the release'):
                    deploy.install_backup(root/'release')
                run.assert_not_called()

    def test_backup_verification_rejects_root_or_missing_memory_isolation(self):
        good = 'User=warehouse-enricher-backup\nGroup=warehouse-enricher-backup\nNoNewPrivileges=yes\nCapabilityBoundingSet=\nProtectSystem=strict\nMemoryMax=402653184'
        with patch.object(deploy, 'run', return_value=good):
            deploy.verify_backup('fixture.service')
        for bad in [good.replace('User=warehouse-enricher-backup','User=root'), good.replace('402653184','infinity')]:
            with patch.object(deploy, 'run', return_value=bad), self.assertRaises(deploy.DeploymentError):
                deploy.verify_backup('fixture.service')


if __name__ == '__main__':
    unittest.main()
