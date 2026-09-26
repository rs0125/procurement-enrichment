import contextlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('trigger_ssm', Path(__file__).parents[1] / 'deploy/trigger-ssm.py')
trigger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trigger)


class TriggerTests(unittest.TestCase):
    def test_invalid_revision_cannot_send_a_command(self):
        with patch.object(trigger, 'aws') as aws:
            with self.assertRaises(trigger.DeploymentError):
                trigger.deploy('main; printenv')
            aws.assert_not_called()

    def test_failure_output_is_not_published_to_actions(self):
        responses = [{'Command': {'CommandId': 'test-command'}},
                     {'Status': 'Failed', 'StandardErrorContent': 'PRIVATE_SENTINEL',
                      'StandardOutputContent': 'PRIVATE_SENTINEL'}]
        output = io.StringIO()
        with patch.object(trigger, 'aws', side_effect=responses), contextlib.redirect_stdout(output):
            with self.assertRaises(trigger.DeploymentError) as error:
                trigger.deploy('f' * 40)
        self.assertNotIn('PRIVATE_SENTINEL', output.getvalue() + str(error.exception))

    def test_pending_command_is_polled_until_success(self):
        responses = [{'Command': {'CommandId': 'test-command'}}, None,
                     {'Status': 'InProgress'}, {'Status': 'Success'}]
        output = io.StringIO()
        with patch.object(trigger, 'aws', side_effect=responses) as aws, patch.object(trigger.time, 'sleep'), contextlib.redirect_stdout(output):
            trigger.deploy('f' * 40)
        self.assertEqual(aws.call_count, 4)
        self.assertIn('Deployed and health-checked revision', output.getvalue())


if __name__ == '__main__':
    unittest.main()
