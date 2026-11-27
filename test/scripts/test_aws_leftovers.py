"""
Tests that `scripts/aws-leftovers.sh` lists the stacks, Thing Groups and
Lambda functions in an account that the repo no longer makes, and deletes
nothing, against a fake AWS CLI on PATH.

Run with: python3 -m unittest discover -s test/scripts
"""

import os
import stat
import subprocess
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPT = os.path.join(ROOT, 'scripts', 'aws-leftovers.sh')

FAKE_AWS = r'''#!/usr/bin/env bash
echo "$*" >> "$CALLS"
case "$1 $2" in
  "cloudformation list-stacks") printf '%s\t%s\t%s\n' $STACKS ;;
  "iot list-thing-groups") printf '%s\t' $GROUPS; echo ;;
  "iot list-things-in-thing-group") echo 0 ;;
  "lambda list-functions") printf '%s\t' $FUNCTIONS; echo ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
'''


class AwsLeftoversTest(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        aws = os.path.join(self.tmp, 'aws')
        with open(aws, 'w') as f:
            f.write(FAKE_AWS)
        os.chmod(aws, os.stat(aws).st_mode | stat.S_IEXEC)
        self.calls = os.path.join(self.tmp, 'calls')

    def run_script(self, stacks, groups, functions):
        env = dict(os.environ, PATH=f'{self.tmp}:{os.environ["PATH"]}', CALLS=self.calls,
                   STACKS=' '.join(stacks), GROUPS=' '.join(groups), FUNCTIONS=' '.join(functions))
        env.pop('GITHUB_ACTIONS', None)
        p = subprocess.run([SCRIPT, 'Dev'], cwd=ROOT, env=env, capture_output=True, text=True)
        return p.returncode, p.stdout + p.stderr

    def current(self):
        stacks = ['cloud-agentic-iot-ota-Dev', 'cloud-agentic-iot-patient-vitals-Dev', 'cloud-agentic-iot-bootstrap-Dev']
        groups = ['fleet-patient-monitor', 'canary-patient-monitor', 'internal-devices']
        functions = ['cloud-agentic-iot-patient-vitals', 'cloud-agentic-iot-ota-saga']
        return stacks, groups, functions

    def test_an_account_the_repo_made_has_no_leftovers(self):
        code, out = self.run_script(*self.current())
        self.assertEqual(code, 0, out)
        self.assertIn('Nothing left over', out)

    def test_lists_an_old_stack_group_and_function_and_deletes_nothing(self):
        stacks, groups, functions = self.current()
        code, out = self.run_script(stacks + ['cloud-agentic-iot-queue-indicator-Dev'],
                                    groups + ['fleet-queue-indicator'],
                                    functions + ['cloud-agentic-iot-old-relay'])
        self.assertEqual(code, 0, out)
        self.assertIn('aws cloudformation delete-stack --stack-name cloud-agentic-iot-queue-indicator-Dev', out)
        self.assertIn('aws iot delete-thing-group --thing-group-name fleet-queue-indicator', out)
        self.assertIn('aws lambda delete-function --function-name cloud-agentic-iot-old-relay', out)
        self.assertIn('3 leftover(s)', out)
        with open(self.calls) as f:
            self.assertNotIn('delete', f.read(), 'read-only: it only lists')


if __name__ == '__main__':
    unittest.main()
