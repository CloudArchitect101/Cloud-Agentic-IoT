"""
Tests for `scripts/ota.sh try` and `scripts/firmware.sh build-as`, against a
fake AWS CLI and a fake arduino-cli.

Each test copies scripts/, firmware/ and config/ into a fresh git repository,
so a build writes nothing into this checkout, and runs the real scripts there.
The fake `aws` answers from a JSON file the test writes and logs every call;
a call the test did not prepare for fails the run. The fake `arduino-cli`
"compiles" a sketch folder into a .bin that names the FIRMWARE_VERSION it was
built with, which is what the checks below look at.

Run with: python3 -m unittest discover -s test/scripts
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ACCOUNT = '367061002723'
REGION = 'us-east-2'
BUCKET = 'cloud-agentic-iot-ota-dev-firmwarebucket-abc123'
ROLE = f'arn:aws:iam::{ACCOUNT}:role/cloud-agentic-iot-ota-Dev-OtaPresignRole-XYZ'
VERSION_RE = re.compile(r'#define\s+FIRMWARE_VERSION\s+"([^"]+)"')

FAKE_AWS = textwrap.dedent(r'''
    #!/usr/bin/env python3
    import json, os, re, shutil, sys

    state_dir = os.environ['FAKE_AWS_STATE']
    with open(os.path.join(state_dir, 'state.json')) as f:
        state = json.load(f)

    def parse(args):
        positional, options, i = [], {}, 0
        while i < len(args):
            a = args[i]
            if a.startswith('--'):
                if i + 1 < len(args) and not args[i + 1].startswith('--'):
                    options[a[2:]] = args[i + 1]
                    i += 2
                    continue
                options[a[2:]] = True
            else:
                positional.append(a)
            i += 1
        return positional, options

    def log(entry):
        with open(os.path.join(state_dir, 'calls.jsonl'), 'a') as f:
            f.write(json.dumps(entry) + '\n')

    def fail(message, code=254):
        sys.stderr.write(message + '\n')
        sys.exit(code)

    def count(name):
        path = os.path.join(state_dir, name + '.count')
        return int(open(path).read()) if os.path.exists(path) else 0

    def next_count(name):
        n = count(name)
        with open(os.path.join(state_dir, name + '.count'), 'w') as f:
            f.write(str(n + 1))
        return n

    positional, options = parse(sys.argv[1:])
    call = ' '.join(positional[:2])
    entry = {'call': call, 'positional': positional, 'options': options}

    if call == 'sts get-caller-identity':
        log(entry)
        print(f"{state['account']}\tarn:aws:sts::{state['account']}:assumed-role/Admin/vitaly")
    elif call == 'configure get':
        log(entry)
        print(state['region'])
    elif call == 'ssm get-parameter':
        log(entry)
        if state.get('label') is None:
            fail('An error occurred (ParameterNotFound) when calling the GetParameter operation')
        print(state['label'])
    elif call == 'cloudformation describe-stacks':
        log(entry)
        outputs = state['stacks'].get(options['stack-name'])
        if outputs is None:
            fail('An error occurred (ValidationError): Stack does not exist')
        key = re.search(r"OutputKey=='([^']+)'", options['query']).group(1)
        print(outputs.get(key, 'None'))
    elif call == 'iot list-things-in-thing-group':
        log(entry)
        things = state['groups'].get(options['thing-group-name'])
        if things is None:
            fail('An error occurred (ResourceNotFoundException): Thing group not found')
        print(json.dumps({'things': things}))
    elif call == 's3api list-objects-v2':
        log(entry)
        keys = [k for k in state['objects'] if k.startswith(options['prefix'])]
        print(json.dumps(keys) if keys else 'null')
    elif call == 's3 cp':
        source, target = positional[2], positional[3]
        with open(source) as f:
            entry['content'] = f.read()
        log(entry)
    elif call == 'iot create-job':
        with open(options['document'][len('file://'):]) as f:
            entry['document'] = json.load(f)
        log(entry)
        print(json.dumps({'jobId': options['job-id']}))
    elif call == 'iot list-job-executions-for-job':
        log(entry)
        polls = state['executions']
        snapshot = polls[min(next_count('executions'), len(polls) - 1)]
        print(json.dumps({'executionSummaries': [
            {'thingArn': f"arn:aws:iot:{state['region']}:{state['account']}:thing/{thing}",
             'jobExecutionSummary': {'status': status}}
            for thing, status in snapshot]}))
    elif call == 'iot describe-job-execution':
        log(entry)
        thing = options['thing-name']
        polls = state['executions']
        statuses = dict(polls[min(max(count('executions') - 1, 0), len(polls) - 1)])
        print(state['details'].get(f"{thing} {statuses.get(thing)}", 'None'))
    else:
        log(entry)
        fail('fake aws: no answer prepared for: ' + ' '.join(sys.argv[1:]), 2)
''').lstrip()

FAKE_ARDUINO = textwrap.dedent(r'''
    #!/usr/bin/env python3
    import json, os, re, sys

    args = sys.argv[1:]
    if not args or args[0] != 'compile':
        sys.stderr.write('fake arduino-cli: only compile is prepared\n')
        sys.exit(2)
    out = args[args.index('--output-dir') + 1]
    folder = args[-1]
    name = os.path.basename(folder.rstrip('/'))
    with open(os.path.join(folder, name + '.ino')) as f:
        version = re.search(r'#define\s+FIRMWARE_VERSION\s+"([^"]+)"', f.read()).group(1)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, name + '.ino.bin'), 'w') as f:
        f.write(f'binary of {name} {version}\n')
    with open(os.path.join(os.environ['FAKE_AWS_STATE'], 'compiles.jsonl'), 'a') as f:
        f.write(json.dumps({'folder': folder, 'version': version}) + '\n')
''').lstrip()


class ScriptFixture(unittest.TestCase):
    """A scratch repository, the fakes on PATH, and a prepared AWS account."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.repo = os.path.join(self.tmp, 'repo')
        for part in ('scripts', 'firmware', 'config'):
            shutil.copytree(os.path.join(REPO, part), os.path.join(self.repo, part),
                            ignore=shutil.ignore_patterns('__pycache__'))
        git = ['git', '-C', self.repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com']
        subprocess.run(['git', 'init', '-q', self.repo], check=True)
        subprocess.run(git + ['add', '-A'], check=True)
        subprocess.run(git + ['commit', '-q', '-m', 'snapshot'], check=True)

        self.bin = os.path.join(self.tmp, 'bin')
        self.state_dir = os.path.join(self.tmp, 'aws')
        os.makedirs(self.bin)
        os.makedirs(self.state_dir)
        for name, body in (('aws', FAKE_AWS), ('arduino-cli', FAKE_ARDUINO)):
            path = os.path.join(self.bin, name)
            with open(path, 'w') as f:
                f.write(body)
            os.chmod(path, 0o755)

        with open(os.path.join(self.repo, 'firmware', 'patient-monitor', 'patient-monitor.ino')) as f:
            self.base = VERSION_RE.search(f.read()).group(1)
        with open(os.path.join(self.repo, 'config', 'Dev.json')) as f:
            self.ota = json.load(f)['ota']
        self.state = {
            'account': ACCOUNT,
            'region': REGION,
            'label': 'Dev',
            'stacks': {'cloud-agentic-iot-ota-Dev': {'FirmwareBucketName': BUCKET, 'OtaPresignRoleArn': ROLE}},
            'groups': {'fleet-patient-monitor': ['Test7', 'Test55']},
            'objects': [f'firmware/patient-monitor/{self.base}.bin'],
            'executions': [
                [('Test7', 'QUEUED'), ('Test55', 'QUEUED')],
                [('Test7', 'IN_PROGRESS'), ('Test55', 'QUEUED')],
                [('Test7', 'SUCCEEDED'), ('Test55', 'SUCCEEDED')],
            ],
            'details': {'Test7 IN_PROGRESS': 'downloading', 'Test7 SUCCEEDED': 'rebooting',
                        'Test55 SUCCEEDED': 'rebooting'},
        }

    def run_script(self, *args, minutes='1'):
        with open(os.path.join(self.state_dir, 'state.json'), 'w') as f:
            json.dump(self.state, f)
        env = {k: v for k, v in os.environ.items() if k not in ('GITHUB_ACTIONS', 'AWS_PROFILE')}
        env.update(PATH=self.bin + os.pathsep + os.environ['PATH'], AWS_REGION=REGION,
                   FAKE_AWS_STATE=self.state_dir, TRY_POLL_SECONDS='0', TRY_WATCH_MINUTES=minutes)
        result = subprocess.run(list(args), cwd=self.repo, env=env, capture_output=True, text=True, timeout=120)
        return result.returncode, result.stdout + result.stderr

    def try_(self, *args, **kwargs):
        return self.run_script(os.path.join(self.repo, 'scripts', 'ota.sh'), 'try', *args, **kwargs)

    def calls(self, name=None):
        path = os.path.join(self.state_dir, 'calls.jsonl')
        if not os.path.exists(path):
            return []
        with open(path) as f:
            entries = [json.loads(line) for line in f]
        return [e for e in entries if name is None or e['call'] == name]

    def compiles(self):
        path = os.path.join(self.state_dir, 'compiles.jsonl')
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return [json.loads(line) for line in f]

    def assert_sent_nothing(self):
        self.assertEqual(self.compiles(), [])
        self.assertEqual(self.calls('s3 cp'), [])
        self.assertEqual(self.calls('iot create-job'), [])


class OtaTryTest(ScriptFixture):

    def test_sends_the_build_to_the_whole_fleet_group_under_a_try_version(self):
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 0, out)
        version = f'{self.base}-try.1'
        key = f'firmware/patient-monitor/try/{version}.bin'

        [build] = self.compiles()
        self.assertEqual(build['version'], version)
        self.assertNotEqual(os.path.realpath(build['folder']),
                            os.path.realpath(os.path.join(self.repo, 'firmware', 'patient-monitor')))
        with open(os.path.join(self.repo, 'firmware', 'patient-monitor', 'patient-monitor.ino')) as f:
            self.assertEqual(VERSION_RE.search(f.read()).group(1), self.base, 'the checkout is left as it was')

        [upload] = self.calls('s3 cp')
        self.assertEqual(upload['positional'][3], f's3://{BUCKET}/{key}')
        self.assertEqual(upload['content'], f'binary of patient-monitor {version}\n')
        self.assertEqual(upload['options']['sse'], 'AES256')

        [job] = self.calls('iot create-job')
        self.assertEqual(job['options']['targets'], f'arn:aws:iot:{REGION}:{ACCOUNT}:thinggroup/fleet-patient-monitor')
        self.assertTrue(job['options']['job-id'].startswith(f"ota-try-patient-monitor-{version.replace('.', '-')}-"))
        self.assertEqual(job['document'], {
            'operation': 'ota', 'sketch': 'patient-monitor', 'version': version,
            'url': '${aws:iot:s3-presigned-url:https://s3.%s.amazonaws.com/%s/%s}' % (REGION, BUCKET, key)})
        self.assertEqual(json.loads(job['options']['presigned-url-config']),
                         {'roleArn': ROLE, 'expiresInSec': self.ota['presignedUrlExpiresInSec']})
        self.assertEqual(json.loads(job['options']['job-executions-rollout-config']), self.ota['firstRing']['rollout'])
        self.assertEqual(json.loads(job['options']['abort-config']), self.ota['firstRing']['abort'])

        self.assertRegex(out, r'Test7\s+IN_PROGRESS\s+downloading')
        self.assertRegex(out, r'Test7\s+SUCCEEDED\s+rebooting')
        self.assertRegex(out, r'Test55\s+SUCCEEDED\s+rebooting')
        self.assertIn(f'aws: connected, patient-monitor v{version}', out)

    def test_never_touches_what_a_release_reads_or_writes(self):
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.calls('ssm put-parameter'), [])
        self.assertEqual(self.calls('s3api head-object'), [])
        for upload in self.calls('s3 cp'):
            self.assertIn('/try/', upload['positional'][3])

    def test_numbers_each_try_after_the_ones_before(self):
        self.state['objects'] += [f'firmware/patient-monitor/try/{self.base}-try.1.bin',
                                  f'firmware/patient-monitor/try/{self.base}-try.2.bin',
                                  f'firmware/patient-monitor/try/{self.base}-try.notes.bin',
                                  'firmware/patient-monitor/try/0.9.0-try.7.bin']
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 0, out)
        [build] = self.compiles()
        self.assertEqual(build['version'], f'{self.base}-try.3')

    def test_says_which_board_did_not_install_it_and_why(self):
        self.state['executions'] = [[('Test7', 'FAILED'), ('Test55', 'SUCCEEDED')]]
        self.state['details'] = {'Test7 FAILED': 'http 403', 'Test55 SUCCEEDED': 'rebooting'}
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'Test7\s+FAILED\s+http 403')
        self.assertIn('1 board(s) did not install', out)

    def test_stops_watching_a_board_that_is_offline_and_says_so(self):
        self.state['executions'] = [[('Test7', 'SUCCEEDED'), ('Test55', 'QUEUED')]]
        code, out = self.try_('Dev', 'patient-monitor', minutes='0')
        self.assertEqual(code, 0, out)
        self.assertRegex(out, r'Test55\s+QUEUED')
        self.assertIn('1 board(s) have not answered yet', out)
        self.assertIn('scripts/ota.sh status Dev', out)

    def test_refuses_prod_before_asking_aws_anything(self):
        code, out = self.try_('Prod', 'patient-monitor')
        self.assertEqual(code, 1, out)
        self.assertIn('Dev boards only', out)
        self.assertEqual(self.calls(), [])
        self.assert_sent_nothing()

    def test_refuses_an_account_labelled_for_another_environment(self):
        self.state['label'] = 'Prod'
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 1, out)
        self.assertIn('labelled Prod, not Dev', out)
        self.assert_sent_nothing()

    def test_never_labels_an_account_itself(self):
        self.state['label'] = None
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 1, out)
        self.assertIn('no environment label', out)
        self.assertEqual(self.calls('ssm put-parameter'), [])
        self.assert_sent_nothing()

    def test_needs_the_ota_stack(self):
        self.state['stacks'] = {}
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 1, out)
        self.assertIn('Deploy AWS to Dev first', out)
        self.assert_sent_nothing()

    def test_builds_nothing_when_no_board_is_in_the_group(self):
        self.state['groups'] = {'fleet-patient-monitor': []}
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 1, out)
        self.assertIn('No board is in fleet-patient-monitor', out)
        self.assert_sent_nothing()

    def test_names_the_sketches_when_given_an_unknown_one(self):
        code, out = self.try_('Dev', 'patient-monitr')
        self.assertEqual(code, 1, out)
        self.assertIn("No sketch named 'patient-monitr'", out)
        self.assertEqual(self.calls(), [])


class BuildAsTest(ScriptFixture):

    def build_as(self, *args):
        return self.run_script(os.path.join(self.repo, 'scripts', 'firmware.sh'), 'build-as', *args)

    def test_compiles_a_copy_under_the_version_given(self):
        code, out = self.build_as('patient-monitor', '9.9.9-try.4')
        self.assertEqual(code, 0, out)
        [build] = self.compiles()
        self.assertEqual(build['version'], '9.9.9-try.4')
        self.assertFalse(os.path.exists(build['folder']), 'the copy is removed afterwards')
        with open(os.path.join(self.repo, 'build', 'firmware', 'patient-monitor', 'patient-monitor.ino.bin')) as f:
            self.assertEqual(f.read(), 'binary of patient-monitor 9.9.9-try.4\n')
        status = subprocess.run(['git', '-C', self.repo, 'status', '--porcelain', '--', 'firmware'],
                                capture_output=True, text=True, check=True).stdout
        self.assertEqual(status, '')

    def test_refuses_a_version_that_is_not_a_plain_version(self):
        for bad in ('2.1.0"; x', '2.1.0/1', '-2.1.0', '2.1.0 1'):
            code, out = self.build_as('patient-monitor', bad)
            self.assertEqual(code, 1, (bad, out))
        self.assertEqual(self.compiles(), [])


if __name__ == '__main__':
    unittest.main()
