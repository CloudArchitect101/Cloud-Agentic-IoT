"""
Tests for scripts/install.sh, the Quick install's one-run deploy.

It only chains other scripts, so here those scripts are stubs that log how
they were called, and `aws` and `sf` are fakes that answer from a small JSON
state. The real scripts/lib/common.sh is used, so the Prod guard is the real
one. Nothing touches a real account or org.

Run with: python3 -m unittest discover -s test/scripts
"""

import json
import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CHAINED = ['seed-ssm.sh', 'check.sh', 'deploy-aws.sh', 'deploy-salesforce.sh', 'publish-agent.sh']

STUB = textwrap.dedent('''\
    #!/usr/bin/env bash
    printf '%s\\n' "$(basename "$0") $* org=${SF_TARGET_ORG:-} key=${SF_INTEGRATION_JWT_KEY_FILE:-} reader=${DATA_CLOUD_READER_USER:-}" >> "$FAKE_STATE/calls.log"
    ''')

FAKE_AWS = textwrap.dedent(r'''
    #!/usr/bin/env python3
    import json, os, re, sys
    d = os.environ['FAKE_STATE']
    state = json.load(open(os.path.join(d, 'state.json')))
    args = sys.argv[1:]
    open(os.path.join(d, 'calls.log'), 'a').write('aws ' + ' '.join(args) + '\n')
    def opt(name):
        return args[args.index(name) + 1] if name in args else None
    if args[:2] == ['iam', 'get-user']:
        sys.exit(0 if opt('--user-name') in state['iam_users'] else 254)
    if args[:2] == ['iam', 'create-user']:
        state['iam_users'].append(opt('--user-name'))
        json.dump(state, open(os.path.join(d, 'state.json'), 'w'))
        print('{}'); sys.exit(0)
    if args[:2] == ['ssm', 'get-parameter']:
        value = state['ssm'].get(opt('--name'))
        if value is None:
            sys.exit(254)
        print(value); sys.exit(0)
    if args[:2] == ['cloudformation', 'describe-stacks']:
        key = re.search(r"OutputKey=='([^']+)'", opt('--query')).group(1)
        print(state['outputs'].get(opt('--stack-name') + '|' + key, 'None')); sys.exit(0)
    sys.stderr.write('fake aws: unexpected call\n'); sys.exit(2)
    ''').lstrip()

FAKE_SF = textwrap.dedent(r'''
    #!/usr/bin/env python3
    import json, os, re, sys
    d = os.environ['FAKE_STATE']
    state = json.load(open(os.path.join(d, 'state.json')))
    args = sys.argv[1:]
    open(os.path.join(d, 'calls.log'), 'a').write('sf ' + ' '.join(args) + '\n')
    def opt(name):
        return args[args.index(name) + 1] if name in args else None
    if args[:2] == ['data', 'query']:
        q = opt('--query')
        if q.startswith('SELECT Id FROM BotVersion WHERE'):
            assert "DeveloperName = 'Patient_Care_Agent'" in q and "Status = 'Active'" in q
            if state.get('agent_query_fails'):
                print(json.dumps({'status': 1, 'name': 'INVALID_TYPE', 'message': 'sObject type BotVersion is not supported'}))
                sys.exit(1)
            n = 1 if state.get('agent_active') else 0
        elif q.startswith('SELECT Id FROM PermissionSet WHERE'):
            name = re.search(r"Name = '([^']+)'", q).group(1)
            n = 1 if name in state['permsets'] else 0
        else:
            name = re.search(r"PermissionSet.Name = '([^']+)'", q).group(1)
            m = re.search(r"Assignee.Username = '([^']+)'", q)
            who = m.group(1) if m else 'autoproc'
            n = 1 if who in state['assigned'].get(name, []) else 0
        print(json.dumps({'result': {'totalSize': n}})); sys.exit(0)
    if args[:3] == ['org', 'assign', 'permset']:
        name, who = opt('--name'), opt('--on-behalf-of') or 'me'
        if who in state['assigned'].get(name, []):
            print('Error: Duplicate PermissionSetAssignment'); sys.exit(1)
        state['assigned'].setdefault(name, []).append(who)
        json.dump(state, open(os.path.join(d, 'state.json'), 'w'))
        print('Permset Assignment ' + name); sys.exit(0)
    if args[:2] == ['apex', 'run']:
        body = sys.stdin.read()
        assert 'AutomatedProcess' in body
        state['assigned'].setdefault('AWS_IoT_Relay_Callers', []).append('autoproc')
        json.dump(state, open(os.path.join(d, 'state.json'), 'w'))
        sys.exit(0)
    sys.stderr.write('fake sf: unexpected call\n'); sys.exit(2)
    ''').lstrip()


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.repo = os.path.join(self.tmp, 'repo')
        os.makedirs(os.path.join(self.repo, 'scripts', 'lib'))
        shutil.copy(os.path.join(REPO, 'scripts', 'install.sh'), os.path.join(self.repo, 'scripts'))
        shutil.copy(os.path.join(REPO, 'scripts', 'lib', 'common.sh'), os.path.join(self.repo, 'scripts', 'lib'))
        for name in CHAINED:
            self._write(os.path.join(self.repo, 'scripts', name), STUB)
        self.state_dir = os.path.join(self.tmp, 'state')
        self.bin = os.path.join(self.tmp, 'bin')
        os.makedirs(self.state_dir)
        os.makedirs(self.bin)
        self._write(os.path.join(self.bin, 'aws'), FAKE_AWS)
        self._write(os.path.join(self.bin, 'sf'), FAKE_SF)
        self.state = {
            'iam_users': [],
            'ssm': {'/cloud-agentic-iot/salesforce/username': 'integration@iot-dev.example.com'},
            'outputs': {'cloud-agentic-iot-queue-relay-Dev|QueueDepthEndpoint': 'https://abc.execute-api.example/Dev'},
            'permsets': ['Device_Platform_Admin', 'Platform_Usage_Viewer', 'Patient_Care_Agent', 'Device_Integration'],
            'assigned': {},
        }

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def _write(self, path, text):
        with open(path, 'w') as f:
            f.write(text)
        os.chmod(path, 0o755)

    def run_install(self, env='Dev', **extra):
        with open(os.path.join(self.state_dir, 'state.json'), 'w') as f:
            json.dump(self.state, f)
        open(os.path.join(self.state_dir, 'calls.log'), 'w').close()
        environ = {k: v for k, v in os.environ.items() if not k.startswith(('SF_', 'DATA_CLOUD', 'SKIP_', 'REPUBLISH_', 'GITHUB_'))}
        environ.update({'PATH': self.bin + os.pathsep + environ['PATH'], 'FAKE_STATE': self.state_dir})
        environ.update(extra)
        result = subprocess.run(['bash', 'scripts/install.sh', env], cwd=self.repo, env=environ,
                                capture_output=True, text=True, stdin=subprocess.DEVNULL)
        with open(os.path.join(self.state_dir, 'calls.log')) as f:
            calls = f.read().splitlines()
        with open(os.path.join(self.state_dir, 'state.json')) as f:
            state = json.load(f)
        return result, calls, state

    def chained(self, calls):
        return [c.split()[0] for c in calls if c.split()[0] in CHAINED]

    def test_refuses_prod_from_a_laptop(self):
        result, calls, _ = self.run_install('Prod')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('pipeline', result.stderr)
        self.assertEqual(calls, [])

    def test_runs_the_scripts_in_the_quick_install_order(self):
        result, calls, _ = self.run_install(SF_TARGET_ORG='test-me')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.chained(calls), CHAINED)
        for call in calls:
            if call.split()[0] in CHAINED:
                self.assertIn('org=test-me', call)
        self.assertIn('Values for the Setup steps', result.stdout)
        self.assertIn('https://abc.execute-api.example/Dev', result.stdout)
        self.assertRegex(result.stdout, r'Step 8a, Slack Request URL +\(not deployed\)')
        self.assertNotIn('None', result.stdout)

    def test_offers_the_integration_key_file_when_it_is_there(self):
        self._write(os.path.join(self.repo, 'scripts', 'server-integration.key'), 'not-a-real-key\n')
        _, calls, _ = self.run_install()
        seed = next(c for c in calls if c.startswith('seed-ssm.sh'))
        self.assertIn('key=scripts/server-integration.key', seed)

    def test_skips_check_and_agent_when_asked(self):
        _, calls, _ = self.run_install(SKIP_CHECK='yes', SKIP_AGENT='yes')
        self.assertEqual(self.chained(calls), ['seed-ssm.sh', 'deploy-aws.sh', 'deploy-salesforce.sh'])

    def test_an_org_that_already_runs_the_agent_keeps_it(self):
        self.state['agent_active'] = True
        result, calls, _ = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('publish-agent.sh', self.chained(calls))
        self.assertIn('REPUBLISH_AGENT=yes', result.stdout + result.stderr)

    def test_an_org_that_cannot_say_is_not_published_to(self):
        self.state['agent_query_fails'] = True
        result, calls, _ = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('publish-agent.sh', self.chained(calls))
        self.assertIn('Could not tell', result.stdout + result.stderr)
        self.assertNotIn('already has an active version', result.stdout + result.stderr)

    def test_republish_agent_replaces_a_running_agent_when_asked(self):
        self.state['agent_active'] = True
        _, calls, _ = self.run_install(REPUBLISH_AGENT='yes')
        self.assertEqual(self.chained(calls), CHAINED)

    def test_creates_the_data_cloud_reader_before_the_aws_deploy(self):
        result, calls, state = self.run_install(DATA_CLOUD_READER_USER='cloud-agentic-iot-data-cloud-reader')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('cloud-agentic-iot-data-cloud-reader', state['iam_users'])
        create = next(i for i, c in enumerate(calls) if c.startswith('aws iam create-user'))
        deploy = next(i for i, c in enumerate(calls) if c.startswith('deploy-aws.sh'))
        self.assertLess(create, deploy)
        self.assertIn('reader=cloud-agentic-iot-data-cloud-reader', calls[deploy])

    def test_keeps_an_existing_data_cloud_reader(self):
        self.state['iam_users'] = ['cloud-agentic-iot-data-cloud-reader']
        _, calls, _ = self.run_install(DATA_CLOUD_READER_USER='cloud-agentic-iot-data-cloud-reader')
        self.assertFalse(any(c.startswith('aws iam create-user') for c in calls))

    def test_assigns_permission_sets_once_and_reports_a_missing_one(self):
        result, _, state = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ['Device_Platform_Admin', 'Platform_Usage_Viewer', 'Patient_Care_Agent']:
            self.assertEqual(state['assigned'][name], ['me'])
        self.assertEqual(state['assigned']['Device_Integration'], ['integration@iot-dev.example.com'])
        self.assertNotIn('AWS_IoT_Relay_Callers', state['assigned'])
        self.assertIn('no AWS_IoT_Relay_Callers yet', result.stderr)

        # A second run, after step 6 made the set: only what is new is assigned.
        self.state = state
        self.state['permsets'].append('AWS_IoT_Relay_Callers')
        result, calls, state = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(state['assigned']['Device_Platform_Admin'], ['me'])
        self.assertEqual(state['assigned']['Device_Integration'], ['integration@iot-dev.example.com'])
        self.assertEqual(sorted(state['assigned']['AWS_IoT_Relay_Callers']), ['autoproc', 'me'])
        self.assertIn('already holds Device_Platform_Admin', result.stdout)

        # A third run changes nothing.
        self.state = state
        result, calls, _ = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(c.startswith('sf apex run') for c in calls))

    def test_waits_for_a_real_integration_username(self):
        self.state['ssm'] = {'/cloud-agentic-iot/salesforce/username': 'placeholder'}
        result, _, state = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('Device_Integration', state['assigned'])
        self.assertIn('No integration username in SSM yet', result.stderr)


if __name__ == '__main__':
    unittest.main()
