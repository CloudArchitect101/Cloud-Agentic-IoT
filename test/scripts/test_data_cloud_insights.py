"""
Tests for scripts/data-cloud-insights.sh, which creates the calculated
insights in datacloud/calculated-insights.json through the Connect REST API.

Each test copies the script, its helpers, sfdx-project.json and datacloud/
into a fresh directory and runs the script there against a fake `sf` on PATH.
The fake answers `sf api request rest` from a JSON file the test writes (which
insights already exist, which ones Data Cloud refuses) and logs every call,
with the body it was sent. Nothing reaches an org.

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
# The script takes its API version from sfdx-project.json, so the test does too.
with open(os.path.join(os.path.dirname(__file__), '..', '..', 'sfdx-project.json')) as _f:
    BASE = '/services/data/v%s/ssot/calculated-insights' % json.load(_f)['sourceApiVersion']

FAKE_SF = textwrap.dedent(r'''
    #!/usr/bin/env python3
    import json, os, sys

    state_dir = os.environ['FAKE_SF_STATE']
    with open(os.path.join(state_dir, 'state.json')) as f:
        state = json.load(f)

    args = sys.argv[1:]
    if args[:3] != ['api', 'request', 'rest']:
        sys.stderr.write('fake sf: not prepared for ' + ' '.join(args) + '\n')
        sys.exit(2)
    url, rest = args[3], args[4:]
    options = {}
    i = 0
    while i < len(rest):
        options[rest[i]] = rest[i + 1]
        i += 2
    body = None
    if '--body' in options:
        with open(options['--body'].lstrip('@')) as f:
            body = json.load(f)
    method = options.get('--method', 'GET')
    with open(os.path.join(state_dir, 'calls.jsonl'), 'a') as f:
        f.write(json.dumps({'method': method, 'url': url, 'options': options, 'body': body}) + '\n')

    if state.get('warn'):
        # What a real sf prints ahead of the answer; the script reads both streams.
        sys.stderr.write(' >   Warning: @salesforce/cli update available from 2.145.6 to 2.158.7.\n')
        sys.stderr.write("Warning: This command is currently in beta. Don't use beta commands in your scripts.\n")
        sys.stderr.flush()
    name = url.rsplit('/', 1)[1]
    if method == 'GET':
        if name in state['existing']:
            print(json.dumps({'apiName': name, 'definitionType': 'CalculatedMetric'}))
        else:
            # What the API answers for a name it does not have; sf exits 0 or not.
            print(json.dumps([{'errorCode': 'NOT_FOUND', 'message': 'The requested resource does not exist'}]))
            sys.exit(1 if state.get('fail_exit') else 0)
    elif method == 'POST':
        if body['apiName'] in state['refused']:
            print(json.dumps([{'errorCode': 'INVALID_INPUT', 'message': 'Field reading_ts__c does not exist'}]))
            sys.exit(1 if state.get('fail_exit') else 0)
        print(json.dumps({'apiName': body['apiName'], 'displayName': body['displayName']}))
    else:
        sys.exit(2)
''').lstrip()


class DataCloudInsights(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.repo = os.path.join(self.tmp, 'repo')
        os.makedirs(os.path.join(self.repo, 'scripts', 'lib'))
        shutil.copy(os.path.join(REPO, 'scripts', 'data-cloud-insights.sh'), os.path.join(self.repo, 'scripts'))
        shutil.copy(os.path.join(REPO, 'scripts', 'lib', 'common.sh'), os.path.join(self.repo, 'scripts', 'lib'))
        shutil.copy(os.path.join(REPO, 'sfdx-project.json'), self.repo)
        shutil.copytree(os.path.join(REPO, 'datacloud'), os.path.join(self.repo, 'datacloud'))
        with open(os.path.join(REPO, 'datacloud', 'calculated-insights.json')) as f:
            self.insights = json.load(f)['insights']
        self.names = [i['apiName'] for i in self.insights]

        self.bin = os.path.join(self.tmp, 'bin')
        self.state_dir = os.path.join(self.tmp, 'sf')
        os.makedirs(self.bin)
        os.makedirs(self.state_dir)
        path = os.path.join(self.bin, 'sf')
        with open(path, 'w') as f:
            f.write(FAKE_SF)
        os.chmod(path, 0o755)
        self.state = {'existing': [], 'refused': []}

    def run_script(self, *args, **env_vars):
        with open(os.path.join(self.state_dir, 'state.json'), 'w') as f:
            json.dump(self.state, f)
        env = {k: v for k, v in os.environ.items() if k not in ('GITHUB_ACTIONS', 'SF_TARGET_ORG')}
        env.update(PATH=self.bin + os.pathsep + os.environ['PATH'], FAKE_SF_STATE=self.state_dir)
        env.update(env_vars)
        result = subprocess.run([os.path.join(self.repo, 'scripts', 'data-cloud-insights.sh'), *args], cwd=self.repo,
                                env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
        return result.returncode, result.stdout + result.stderr

    def calls(self):
        path = os.path.join(self.state_dir, 'calls.jsonl')
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return [json.loads(line) for line in f]

    def posts(self):
        return [c for c in self.calls() if c['method'] == 'POST']

    def test_each_insight_is_created_with_its_sql_as_it_is_in_the_repo(self):
        code, out = self.run_script(SF_TARGET_ORG='test-org')
        self.assertEqual(code, 0, out)
        posts = self.posts()
        self.assertEqual([p['body']['apiName'] for p in posts], self.names)
        for post, insight in zip(posts, self.insights):
            self.assertEqual(post['url'], BASE)
            self.assertEqual(post['options']['--target-org'], 'test-org')
            self.assertEqual(post['options']['--header'], 'Content-Type: application/json')
            with open(os.path.join(REPO, 'datacloud', insight['sql'])) as f:
                self.assertEqual(post['body']['expression'], f.read().strip())
            self.assertEqual(post['body']['definitionType'], 'CalculatedMetric')
            self.assertEqual(post['body']['displayName'], insight['displayName'])
            # Data Cloud refuses a create without it (REQUIRED_FIELD_MISSING).
            self.assertEqual(post['body']['publishScheduleInterval'], insight['publishScheduleInterval'])
            # And its first run, the next whole hour in UTC ("Schedule start date is required.").
            self.assertRegex(post['body']['publishScheduleStartDateTime'], r'^\d{4}-\d\d-\d\dT\d\d:00:00\.000Z$')
        self.assertIn('2 created, 0 already there', out)

    def test_an_insight_that_exists_is_left_as_it_is(self):
        self.state['existing'] = [self.names[0]]
        code, out = self.run_script(SF_TARGET_ORG='test-org')
        self.assertEqual(code, 0, out)
        self.assertEqual([p['body']['apiName'] for p in self.posts()], self.names[1:])
        self.assertIn('1 created, 1 already there', out)

    def test_a_refused_insight_fails_the_run_names_it_and_the_rest_still_go(self):
        for fail_exit in (False, True):
            with self.subTest(sf_exits_nonzero=fail_exit):
                if os.path.exists(os.path.join(self.state_dir, 'calls.jsonl')):
                    os.remove(os.path.join(self.state_dir, 'calls.jsonl'))
                self.state.update(refused=[self.names[0]], fail_exit=fail_exit)
                code, out = self.run_script(SF_TARGET_ORG='test-org')
                self.assertNotEqual(code, 0, out)
                self.assertIn(f'did not take: {self.names[0]}', out)
                self.assertIn('reading_ts__c does not exist', out)
                self.assertEqual([p['body']['apiName'] for p in self.posts()], self.names)

    def test_sf_warnings_ahead_of_the_answer_do_not_hide_a_created_insight(self):
        # Nov 19: the insight was created, but the warnings sf prints first made
        # the answer unreadable as JSON, so the run called it refused.
        self.state['warn'] = True
        code, out = self.run_script(SF_TARGET_ORG='test-org')
        self.assertEqual(code, 0, out)
        self.assertIn('2 created, 0 already there', out)

    def test_a_dry_run_sends_nothing(self):
        code, out = self.run_script('--dry-run', SF_TARGET_ORG='test-org')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.calls(), [])
        for name in self.names:
            self.assertIn(f'"apiName": "{name}"', out)

    def test_without_an_org_nothing_runs(self):
        code, out = self.run_script()
        self.assertNotEqual(code, 0)
        self.assertIn('Set SF_TARGET_ORG', out)
        self.assertEqual(self.calls(), [])


if __name__ == '__main__':
    unittest.main()
