import datetime
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ec2_release', Path(__file__).parents[1] / 'deploy/ec2-release.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentTests(unittest.TestCase):
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
            with patch.multiple(deploy, CURRENT=current, RELEASES=root), patch.object(deploy, 'check_schedule'), patch.object(deploy, 'prepare', return_value=release), patch.object(deploy.shutil, 'chown'), patch.object(deploy.Path, 'mkdir'), patch.object(deploy, 'verify') as verify, patch.object(deploy, 'promote') as promote:
                deploy.deploy('f' * 40)
                verify.assert_called_once_with(3000)
                promote.assert_not_called()


if __name__ == '__main__':
    unittest.main()
