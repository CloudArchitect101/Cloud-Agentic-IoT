"""
Tests for `scripts/ota.sh try` and `scripts/firmware.sh build-as`, against a
fake AWS CLI and a fake arduino-cli.

Each test copies the files Git tracks (or would track) under scripts/,
firmware/ and config/ into a fresh git repository, so a build writes nothing
into this checkout and no ignored file (a key, a .secrets file) is ever copied,
and runs the real scripts there.
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
ACCOUNT = '111122223333'
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
        if state.get('label_error'):
            fail(state['label_error'])
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
        if options['thing-group-name'] not in state['groups']:
            fail('An error occurred (ResourceNotFoundException): Thing group not found')
        # Only --recursive reaches the boards of the groups inside this one.
        groups, things = [options['thing-group-name']], []
        while groups:
            group = groups.pop(0)
            things += state['groups'].get(group, [])
            if options.get('recursive'):
                groups += state.get('children', {}).get(group, [])
        print(json.dumps({'things': things}))
    elif call == 's3api list-objects-v2':
        log(entry)
        keys = [k for k in state['objects'] if k.startswith(options['prefix'])]
        print(json.dumps(keys) if keys else 'null')
    elif call == 's3api head-object':
        log(entry)
        if options['key'] not in state['objects']:
            fail('An error occurred (404) when calling the HeadObject operation: Not Found')
        print(json.dumps({'ContentLength': 1}))
    elif call == 'iot describe-job':
        log(entry)
        print(json.dumps(state['job_details'][options['job-id']]))
    elif call == 's3 cp':
        source, target = positional[2], positional[3]
        with open(source) as f:
            entry['content'] = f.read()
        log(entry)
    elif call == 'iot create-job':
        with open(options['document'][len('file://'):]) as f:
            entry['document'] = json.load(f)
        log(entry)
        with open(os.path.join(state_dir, 'created.jsonl'), 'a') as f:
            f.write(json.dumps({'jobId': options['job-id'], 'status': 'IN_PROGRESS',
                                'group': options['targets'].rsplit('/', 1)[1]}) + '\n')
        print(json.dumps({'jobId': options['job-id']}))
    elif call == 'iot list-jobs':
        log(entry)
        if state.get('list_jobs_fails'):
            fail('An error occurred (ThrottlingException) when calling the ListJobs operation: Rate exceeded')
        jobs = list(state.get('jobs', []))
        created = os.path.join(state_dir, 'created.jsonl')
        if os.path.exists(created):
            with open(created) as f:
                jobs += [json.loads(line) for line in f]
        prefix = re.search(r"starts_with\(jobId, '([^']*)'\)", options['query']).group(1)
        # Without --thing-group-name AWS lists the jobs of every group.
        found = [j['jobId'] for j in jobs
                 if j['status'] == options['status']
                 and options.get('thing-group-name', j['group']) == j['group']
                 and j['jobId'].startswith(prefix)]
        print(json.dumps(found) if options.get('output') == 'json' else '\t'.join(found))
    elif call == 'iot cancel-job':
        log(entry)
        if state.get('cancel_fails'):
            fail('An error occurred (InvalidRequestException) when calling the CancelJob operation: '
                 'The job is already in a terminal state')
        print(json.dumps({'jobId': options['job-id']}))
    elif call == 'iot list-job-executions-for-job':
        log(entry)
        if next_count('polls') in state.get('failing_polls', []):
            fail('An error occurred (ExpiredTokenException) when calling the ListJobExecutionsForJob '
                 'operation: The security token included in the request is expired')
        polls = state['executions']
        snapshot = polls[min(next_count('executions'), len(polls) - 1)]
        print(json.dumps({'executionSummaries': [
            {'thingArn': f"arn:aws:iot:{state['region']}:{state['account']}:thing/{thing}",
             'jobExecutionSummary': {'status': status}}
            for thing, status in snapshot]}))
    elif call in ('iot add-thing-to-thing-group', 'iot remove-thing-from-thing-group'):
        log(entry)
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
    if args[:2] == ['core', 'list']:
        print('esp32:esp32 3.0.7 3.0.7 esp32')
        sys.exit(0)
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
    if os.environ.get('FAKE_COMPILE_FAILS'):
        sys.stderr.write('error: compilation failed\n')
        sys.exit(1)
''').lstrip()


class ScriptFixture(unittest.TestCase):
    """A scratch repository, the fakes on PATH, and a prepared AWS account."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.repo = os.path.join(self.tmp, 'repo')
        # What Git tracks or would track: an ignored file (a key, a .secrets
        # file, a build) never leaves this checkout.
        listed = subprocess.run(['git', '-C', REPO, 'ls-files', '-z', '--cached', '--others', '--exclude-standard',
                                 '--', 'scripts', 'firmware', 'config'],
                                capture_output=True, check=True).stdout.decode().split('\0')
        for name in filter(None, listed):
            source = os.path.join(REPO, name)
            if os.path.isfile(source):   # a tracked file deleted in this checkout is skipped
                os.makedirs(os.path.dirname(os.path.join(self.repo, name)), exist_ok=True)
                shutil.copy2(source, os.path.join(self.repo, name))
        # The commit must not depend on how this machine's Git is set up: no
        # signing prompt, no hooks.
        git = ['git', '-C', self.repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
               '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null']
        subprocess.run(['git', 'init', '-q', self.repo], check=True)
        subprocess.run(git + ['add', '-A'], check=True)
        subprocess.run(git + ['commit', '-q', '--no-verify', '-m', 'snapshot'], check=True)

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

    def run_script(self, *args, minutes='1', ci=False):
        with open(os.path.join(self.state_dir, 'state.json'), 'w') as f:
            json.dump(self.state, f)
        env = {k: v for k, v in os.environ.items() if k not in ('GITHUB_ACTIONS', 'AWS_PROFILE')}
        if ci:   # a release runs in the pipeline only
            env['GITHUB_ACTIONS'] = 'true'
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

    def forget_calls(self):
        """Starts the fake AWS afresh, for a second run in one test."""
        for name in os.listdir(self.state_dir):
            os.remove(os.path.join(self.state_dir, name))

    def write(self, name, text, mode='w'):
        with open(os.path.join(self.repo, name), mode) as f:
            f.write(text)

    def head(self):
        return subprocess.run(['git', '-C', self.repo, 'rev-parse', '--short', 'HEAD'],
                              capture_output=True, text=True, check=True).stdout.strip()

    def source_sent(self):
        """The source the upload and the job say the build came from."""
        [upload] = self.calls('s3 cp')
        [job] = self.calls('iot create-job')
        source = upload['options']['metadata'][len('git-sha='):]
        self.assertTrue(job['options']['description'].endswith(f'(Dev, {source})'), job['options']['description'])
        return source


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
        self.assertNotIn('have not answered yet', out)
        self.assertIn(f'aws: connected, patient-monitor v{version}', out)

    def test_reaches_the_boards_in_the_groups_inside_the_fleet_group(self):
        self.state['groups'] = {'fleet-patient-monitor': ['Test7'], 'canary-patient-monitor': ['Test55']}
        self.state['children'] = {'fleet-patient-monitor': ['canary-patient-monitor']}
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 0, out)
        [listing] = self.calls('iot list-things-in-thing-group')
        self.assertIs(listing['options'].get('recursive'), True)
        self.assertIn('2 board(s)', out)
        self.assertIn('fleet-patient-monitor: Test7 Test55', out)
        self.assertRegex(out, r'Test55\s+SUCCEEDED')

    def test_reaches_the_internal_boards_with_the_one_build(self):
        # A ward board (Internal_Device in Salesforce) runs the patient-monitor
        # build too, from internal-devices inside the fleet group.
        self.state['groups'] = {'fleet-patient-monitor': ['Test7'], 'internal-devices': ['Test55']}
        self.state['children'] = {'fleet-patient-monitor': ['internal-devices']}
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 0, out)
        [job] = self.calls('iot create-job')
        self.assertEqual(job['options']['targets'], f'arn:aws:iot:{REGION}:{ACCOUNT}:thinggroup/fleet-patient-monitor')
        self.assertEqual(job['document']['sketch'], 'patient-monitor')
        self.assertIn('fleet-patient-monitor: Test7 Test55', out)

    def test_never_touches_what_a_release_reads_or_writes(self):
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.calls('ssm put-parameter'), [])
        self.assertEqual(self.calls('s3api head-object'), [])
        for upload in self.calls('s3 cp'):
            self.assertIn('/try/', upload['positional'][3])

    def test_numbers_each_try_after_the_highest_before_it(self):
        # 10 is the highest: a sort by text would put 2 last.
        self.state['objects'] += [f'firmware/patient-monitor/try/{self.base}-try.2.bin',
                                  f'firmware/patient-monitor/try/{self.base}-try.10.bin',
                                  f'firmware/patient-monitor/try/{self.base}-try.notes.bin',
                                  'firmware/patient-monitor/try/0.9.0-try.70.bin']
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 0, out)
        [build] = self.compiles()
        self.assertEqual(build['version'], f'{self.base}-try.11')

    def test_names_the_commit_a_build_came_from(self):
        self.write('notes.txt', 'a file outside firmware/ changes nothing the boards run\n')
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.source_sent(), self.head())

    def test_marks_a_build_with_an_edit_no_commit_holds(self):
        self.write('firmware/patient-monitor/patient-monitor.ino', '// a local tweak\n', mode='a')
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.source_sent(), f'{self.head()}+local-changes')

    def test_marks_a_build_with_a_new_file_no_commit_holds(self):
        self.write('firmware/patient-monitor/extra.h', '#pragma once\n')
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.source_sent(), f'{self.head()}+local-changes')

    def test_cancels_the_earlier_tries_of_that_type_only(self):
        earlier = 'ota-try-patient-monitor-2-1-0-try-1-1793900000'
        self.state['jobs'] = [
            {'jobId': earlier, 'status': 'IN_PROGRESS', 'group': 'fleet-patient-monitor'},
            {'jobId': 'ota-try-patient-monitor-2-1-0-try-2-1793900100', 'status': 'COMPLETED',
             'group': 'fleet-patient-monitor'},
            {'jobId': 'interval-patient-monitor-60-1793900200', 'status': 'IN_PROGRESS',
             'group': 'fleet-patient-monitor'},
            {'jobId': 'ota-patient-monitor-2-1-0-1793900300', 'status': 'IN_PROGRESS',
             'group': 'fleet-patient-monitor'},
            {'jobId': 'ota-try-patient-monitor-x-1-0-0-try-1-1793900400', 'status': 'IN_PROGRESS',
             'group': 'fleet-patient-monitor-x'},
        ]
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 0, out)
        [job] = self.calls('iot create-job')
        [cancel] = self.calls('iot cancel-job')
        self.assertEqual(cancel['options']['job-id'], earlier)
        self.assertEqual(cancel['options']['comment'], f"Replaced by {job['options']['job-id']}")
        self.assertNotIn('force', cancel['options'], 'a board already installing it finishes')
        self.assertIn(f'Cancelled the earlier try {earlier}', out)

    def test_a_try_carries_on_when_earlier_tries_cannot_be_cancelled(self):
        self.state['jobs'] = [{'jobId': 'ota-try-patient-monitor-2-1-0-try-1-1793900000', 'status': 'IN_PROGRESS',
                               'group': 'fleet-patient-monitor'}]
        before = dict(self.state)
        for failure, says in (('cancel_fails', 'Could not cancel the earlier try'),
                              ('list_jobs_fails', 'Could not list the earlier tries')):
            with self.subTest(failure=failure):
                self.forget_calls()
                self.state = dict(before, **{failure: True})
                code, out = self.try_('Dev', 'patient-monitor')
                self.assertEqual(code, 0, out)
                self.assertIn(says, out)
                self.assertRegex(out, r'Test55\s+SUCCEEDED')

    def test_a_board_on_2_2_0_answers_once_it_runs_the_new_build_so_no_console_check_is_asked(self):
        version = f'{self.base}-try.1'
        self.state['executions'] = [
            [('Test7', 'IN_PROGRESS'), ('Test55', 'IN_PROGRESS')],
            [('Test7', 'SUCCEEDED'), ('Test55', 'SUCCEEDED')],
        ]
        self.state['details'] = {'Test7 IN_PROGRESS': 'downloading', 'Test55 IN_PROGRESS': 'rebooting',
                                 'Test7 SUCCEEDED': f'running {version}', 'Test55 SUCCEEDED': f'running {version}'}
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 0, out)
        self.assertRegex(out, rf'Test7\s+SUCCEEDED\s+running {re.escape(version)}')
        self.assertRegex(out, rf'Test55\s+SUCCEEDED\s+running {re.escape(version)}')
        self.assertNotIn('aws: connected', out)
        self.assertNotIn('older than 2.2.0', out)

    def test_names_only_the_boards_that_answered_before_restarting(self):
        version = f'{self.base}-try.1'
        self.state['executions'] = [[('Test7', 'SUCCEEDED'), ('Test55', 'SUCCEEDED')]]
        self.state['details'] = {'Test7 SUCCEEDED': f'running {version}', 'Test55 SUCCEEDED': 'rebooting'}
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 0, out)
        self.assertIn('as firmware older than 2.2.0 does: Test55.', out)
        self.assertIn(f'aws: connected, patient-monitor v{version}', out)

    def test_a_board_that_came_back_on_its_old_build_fails_the_try(self):
        self.state['executions'] = [[('Test7', 'FAILED'), ('Test55', 'SUCCEEDED')]]
        self.state['details'] = {'Test7 FAILED': 'came back on 2.1.0', 'Test55 SUCCEEDED': 'running 2.2.0-try.1'}
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'Test7\s+FAILED\s+came back on 2\.1\.0')
        self.assertIn('1 board(s) did not install', out)

    def test_says_which_board_did_not_install_it_and_why(self):
        self.state['executions'] = [[('Test7', 'FAILED'), ('Test55', 'SUCCEEDED')]]
        self.state['details'] = {'Test7 FAILED': 'http 403', 'Test55 SUCCEEDED': 'rebooting'}
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r'Test7\s+FAILED\s+http 403')
        self.assertIn('1 board(s) did not install', out)

    def test_fails_when_a_board_refused_it_timed_out_or_lost_it(self):
        for status in ('REJECTED', 'TIMED_OUT', 'CANCELED', 'REMOVED'):
            with self.subTest(status=status):
                self.forget_calls()
                self.state['executions'] = [[('Test7', status), ('Test55', 'SUCCEEDED')]]
                code, out = self.try_('Dev', 'patient-monitor')
                self.assertEqual(code, 1, out)
                self.assertRegex(out, rf'Test7\s+{status}')
                self.assertIn('1 board(s) did not install', out)

    def test_keeps_watching_when_a_poll_fails(self):
        self.state['failing_polls'] = [0, 1]
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 0, out)
        self.assertEqual(out.count("Could not read the job's progress"), 1, out)
        self.assertRegex(out, r'Test7\s+SUCCEEDED\s+rebooting')
        self.assertRegex(out, r'Test55\s+SUCCEEDED\s+rebooting')

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
        self.assertIn(f'no environment label in {REGION}', out)
        self.assertIn('set AWS_REGION', out)
        self.assertEqual(self.calls('ssm put-parameter'), [])
        self.assert_sent_nothing()

    def test_says_why_the_label_could_not_be_read(self):
        self.state['label_error'] = ('An error occurred (AccessDeniedException) when calling the GetParameter '
                                     'operation: not authorized to perform: ssm:GetParameter')
        code, out = self.try_('Dev', 'patient-monitor')
        self.assertEqual(code, 1, out)
        self.assertIn(f'Could not read /cloud-agentic-iot/environment in {REGION}', out)
        self.assertIn('AccessDeniedException', out)
        self.assertNotIn('no environment label', out)
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


class OtaJoinTest(ScriptFixture):

    def join(self, *args):
        return self.run_script(os.path.join(self.repo, 'scripts', 'ota.sh'), 'join', *args)

    def moves(self):
        return ([(c['options']['thing-name'], c['options']['thing-group-name'])
                 for c in self.calls('iot remove-thing-from-thing-group')],
                [(c['options']['thing-name'], c['options']['thing-group-name'])
                 for c in self.calls('iot add-thing-to-thing-group')])

    def test_internal_leaves_the_other_groups_of_the_fleet_first(self):
        code, out = self.join('Dev', 'Test7', 'patient-monitor', 'internal')
        self.assertEqual(code, 0, out)
        removed, added = self.moves()
        self.assertEqual(sorted(removed), [('Test7', 'canary-patient-monitor'), ('Test7', 'fleet-patient-monitor')])
        self.assertEqual(added, [('Test7', 'internal-devices')])
        self.assertIn('Test7 is in internal-devices.', out)

    def test_fleet_and_canary_leave_internal_devices_too(self):
        for ring, group in (('canary', 'canary-patient-monitor'), (None, 'fleet-patient-monitor')):
            self.forget_calls()
            code, out = self.join('Dev', 'Test7', 'patient-monitor', *([ring] if ring else []))
            self.assertEqual(code, 0, out)
            removed, added = self.moves()
            self.assertIn(('Test7', 'internal-devices'), removed)
            self.assertNotIn(('Test7', group), removed)
            self.assertEqual(added, [('Test7', group)])

    def test_only_a_patient_monitor_can_be_internal(self):
        # Every board runs patient-monitor today, so a second sketch is made up.
        other = os.path.join(self.repo, 'firmware', 'other-device')
        os.makedirs(other)
        with open(os.path.join(other, 'other-device.ino'), 'w') as f:
            f.write('#define FIRMWARE_VERSION "1.0.0"\n')
        code, out = self.join('Dev', 'OD1', 'other-device', 'internal')
        self.assertEqual(code, 1, out)
        self.assertIn('Only a patient-monitor board can be internal', out)
        self.assertEqual(self.calls(), [])

    def test_refuses_an_unknown_ring(self):
        code, out = self.join('Dev', 'Test7', 'patient-monitor', 'ward')
        self.assertEqual(code, 1, out)
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
        # arduino-cli is silent while it works: the script says how long to
        # expect, and how long it took. No ticks outside a terminal.
        self.assertIn('Usually 1 to 3 minutes', out)
        self.assertRegex(out, r'Compiled patient-monitor 9\.9\.9-try\.4 in \d+ s\.')
        self.assertNotIn('still compiling', out)
        with open(os.path.join(self.repo, 'build', 'firmware', 'patient-monitor', 'patient-monitor.ino.bin')) as f:
            self.assertEqual(f.read(), 'binary of patient-monitor 9.9.9-try.4\n')
        status = subprocess.run(['git', '-C', self.repo, 'status', '--porcelain', '--', 'firmware'],
                                capture_output=True, text=True, check=True).stdout
        self.assertEqual(status, '')

    def test_a_failed_compile_says_so_and_removes_the_copy(self):
        os.environ['FAKE_COMPILE_FAILS'] = '1'
        self.addCleanup(os.environ.pop, 'FAKE_COMPILE_FAILS', None)
        code, out = self.build_as('patient-monitor', '9.9.9-try.5')
        self.assertNotEqual(code, 0, out)
        self.assertIn('Compiling patient-monitor failed (exit 1)', out)
        self.assertNotIn('Compiled patient-monitor', out)
        [build] = self.compiles()
        self.assertFalse(os.path.exists(build['folder']), 'the copy is removed afterwards')

    def test_refuses_a_version_that_is_not_a_plain_version(self):
        for bad in ('2.1.0"; x', '2.1.0/1', '-2.1.0', '2.1.0 1'):
            code, out = self.build_as('patient-monitor', bad)
            self.assertEqual(code, 1, (bad, out))
        self.assertEqual(self.compiles(), [])


if __name__ == '__main__':
    unittest.main()
