"""
Tests for the scripts that set an environment up and guard its deploys:
scripts/seed-ssm.sh, scripts/bootstrap-aws.sh, scripts/deploy-salesforce.sh's
org pairing and scripts/deploy-aws.sh's guards, alarm topic and log retention.

Each test copies the files Git tracks (or would track) under scripts/,
config/, infra/, lambda/ and knowledge/, plus one Salesforce file, into a fresh git
repository, so nothing is written into this checkout and no ignored file (a
key, a .secrets file) is ever copied. It runs the real scripts there against
fakes on PATH: an `aws` that keeps SSM parameters and stacks in a JSON file and
logs every call, an `sf` that knows one org, a `gh` that knows one repository,
and `npm` and `zip` that only pretend to package a function. A call a fake was
not prepared for fails the run.

Run with: python3 -m unittest discover -s test/scripts
"""

import base64
import json
import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
# Documentation account IDs: no real account appears here.
ACCOUNT = '111122223333'
REGION = 'ca-central-1'
ORG_ID = '00D000000000001EAA'
OTHER_ORG_ID = '00D000000000002EAA'
PEM = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n'
SF = '/cloud-agentic-iot/salesforce'
LABEL = '/cloud-agentic-iot/environment'
TOPIC = f'arn:aws:sns:{REGION}:{ACCOUNT}:cloud-agentic-iot-alarms'
OTA_BUCKET = 'cloud-agentic-iot-ota-dev-firmwarebucket-abc123'
OTA_ROLE = 'arn:aws:iam::111122223333:role/cloud-agentic-iot-ota-Dev-OtaPresignRole-XYZ'

FAKE_AWS = textwrap.dedent(r'''
    #!/usr/bin/env python3
    import json, os, re, sys

    state_dir = os.environ['FAKE_AWS_STATE']
    path = os.path.join(state_dir, 'state.json')
    with open(path) as f:
        state = json.load(f)

    def save():
        with open(path, 'w') as f:
            json.dump(state, f)

    # Every option keeps all the words after it, so --parameter-overrides A=1 B=2
    # reads as a list.
    args, positional, options = sys.argv[1:], [], {}
    i = 0
    while i < len(args):
        if args[i].startswith('--'):
            name, values = args[i][2:], []
            i += 1
            while i < len(args) and not args[i].startswith('--'):
                values.append(args[i])
                i += 1
            options[name] = values
        else:
            positional.append(args[i])
            i += 1
    one = lambda name: (options.get(name) or [None])[0]

    def value_of(text):
        if text.startswith('file://'):
            with open(text[len('file://'):]) as f:
                return f.read()
        return text

    call = ' '.join(positional[:2])
    entry = {'call': call, 'options': options}
    if call == 'ssm put-parameter':
        entry['raw_value'] = one('value')
    with open(os.path.join(state_dir, 'calls.jsonl'), 'a') as f:
        f.write(json.dumps(entry) + '\n')

    def fail(message, code=254):
        sys.stderr.write(message + '\n')
        sys.exit(code)

    params = state.setdefault('params', {})
    if call == 'sts get-caller-identity':
        print(f"{state['account']}\tarn:aws:sts::{state['account']}:assumed-role/Operator/someone")
    elif call == 'configure get':
        print(state['region'])
    elif call == 'ssm get-parameter':
        if state.get('scp_denies'):
            fail(f"An error occurred (AccessDeniedException) when calling the GetParameter operation: "
                 f"User: arn:aws:sts::{state['account']}:assumed-role/Operator/someone is not authorized to perform: "
                 f"ssm:GetParameter with an explicit deny in a service control policy")
        p = params.get(one('name'))
        if p is None:
            fail('An error occurred (ParameterNotFound) when calling the GetParameter operation')
        print(p['name'] if one('query') == 'Parameter.Name' else p['value'])
    elif call == 'ssm put-parameter':
        name = one('name')
        if name in params and 'overwrite' not in options:
            fail('An error occurred (ParameterAlreadyExists) when calling the PutParameter operation')
        if name in params and params[name]['type'] != one('type'):
            fail('An error occurred (HierarchyTypeMismatchException) when calling the PutParameter operation')
        params[name] = {'name': name, 'type': one('type'), 'value': value_of(one('value'))}
        save()
    elif call == 'ssm describe-parameters':
        name = re.search(r'Values=(.+)$', one('parameter-filters')).group(1)
        print(params[name]['type'] if name in params else 'None')
    elif call == 'ssm delete-parameter':
        params.pop(one('name'))
        save()
    elif call == 'cloudformation validate-template':
        pass
    elif call == 'cloudformation describe-stacks':
        stack = state.setdefault('stacks', {}).get(one('stack-name'))
        if stack is None:
            fail('An error occurred (ValidationError): Stack with id %s does not exist' % one('stack-name'))
        if one('query'):
            key = re.search(r"OutputKey=='([^']+)'", one('query')).group(1)
            print(stack.get(key, 'None'))
    elif call == 'cloudformation deploy':
        name = one('stack-name')
        state.setdefault('stacks', {}).setdefault(name, dict(state.get('outputs', {}).get(name, {})))
        save()
    elif call == 'iam list-open-id-connect-providers':
        print(state.get('oidc_provider', ''))
    elif call == 'lambda get-function':
        if positional and one('function-name') not in state.get('functions', []):
            fail('An error occurred (ResourceNotFoundException): Function not found')
    elif call in ('lambda wait', 'lambda update-function-code', 'logs put-retention-policy'):
        pass
    elif call == 'lambda invoke':
        # scripts/index-sops.sh: the payload is a file, the answer goes to the
        # last argument. state['invoke_answer'] says what the function answers.
        payload = one('payload')
        with open(payload[len('fileb://'):]) as f:
            entry_payload = json.load(f)
        with open(os.path.join(state_dir, 'invoked.jsonl'), 'a') as f:
            f.write(json.dumps({'function': one('function-name'), 'payload': entry_payload}) + '\n')
        with open(sys.argv[-1], 'w') as f:
            json.dump(state.get('invoke_answer', {'ok': True, 'unchanged': False, 'documents': 7, 'chunks': 24}), f)
        status = {'StatusCode': 200, 'ExecutedVersion': '$LATEST'}
        if state.get('invoke_error'):
            status['FunctionError'] = 'Unhandled'
        print(json.dumps(status))
    elif call == 'logs create-log-group':
        groups = state.setdefault('log_groups', [])
        if one('log-group-name') in groups:
            fail('An error occurred (ResourceAlreadyExistsException) when calling the CreateLogGroup operation')
        groups.append(one('log-group-name'))
        save()
    else:
        fail('fake aws: no answer prepared for: ' + ' '.join(sys.argv[1:]), 2)
''').lstrip()

FAKE_SF = textwrap.dedent(r'''
    #!/usr/bin/env python3
    import json, os, sys

    state_dir = os.environ['FAKE_AWS_STATE']
    with open(os.path.join(state_dir, 'state.json')) as f:
        org = json.load(f)['org']
    with open(os.path.join(state_dir, 'sf.jsonl'), 'a') as f:
        f.write(json.dumps(sys.argv[1:]) + '\n')
    args = sys.argv[1:]
    if args[:2] == ['org', 'display']:
        print(json.dumps({'status': 0, 'result': {'username': org['username'], 'id': org['id']}}))
    elif args[:3] == ['project', 'deploy', 'start']:
        print('Deployed.')
    elif args[:3] == ['project', 'deploy', 'validate']:
        print(json.dumps({'status': 0, 'result': {'id': '0AfVALIDATION'}}))
    elif args[:3] in (['project', 'deploy', 'resume'], ['project', 'deploy', 'quick']):
        print('Done.')
    elif args[:3] == ['project', 'generate', 'manifest']:
        out = args[args.index('--output-dir') + 1]
        with open(os.path.join(out, 'package.xml'), 'w') as f:
            f.write('<Package/>\n')
    else:
        sys.stderr.write('fake sf: no answer prepared for: ' + ' '.join(args) + '\n')
        sys.exit(2)
''').lstrip()

FAKE_GH = textwrap.dedent(r'''
    #!/usr/bin/env python3
    import json, os, sys

    state_dir = os.environ['FAKE_AWS_STATE']
    with open(os.path.join(state_dir, 'gh.jsonl'), 'a') as f:
        f.write(json.dumps(sys.argv[1:]) + '\n')
    if sys.argv[1:2] == ['api'] and sys.argv[2].startswith('repos/'):
        print('ExampleOwner/cloud-agentic-iot 1001 2002')
    else:
        sys.stderr.write('fake gh: no answer prepared\n')
        sys.exit(2)
''').lstrip()

FAKE_NPM = '#!/bin/sh\nexit 0\n'
# zip -qr <archive> . : writes a file where the archive goes.
FAKE_ZIP = '#!/bin/sh\necho zip > "$2"\n'


class SetupFixture(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.repo = os.path.join(self.tmp, 'repo')
        listed = subprocess.run(['git', '-C', REPO, 'ls-files', '-z', '--cached', '--others', '--exclude-standard',
                                 '--', 'scripts', 'config', 'infra', 'lambda', 'knowledge'],
                                capture_output=True, check=True).stdout.decode().split('\0')
        listed.append('sfdx-project.json')
        for name in filter(None, listed):
            source = os.path.join(REPO, name)
            if os.path.isfile(source) and '/node_modules/' not in name:
                os.makedirs(os.path.dirname(os.path.join(self.repo, name)) or self.repo, exist_ok=True)
                shutil.copy2(source, os.path.join(self.repo, name))
        # deploy-salesforce.sh deploys nothing from an empty force-app.
        self.write('force-app/main/default/labels/CustomLabels.labels-meta.xml', '<CustomLabels/>\n')
        self.git = ['git', '-C', self.repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null']
        subprocess.run(['git', 'init', '-q', self.repo], check=True)
        subprocess.run(self.git + ['add', '-A'], check=True)
        subprocess.run(self.git + ['commit', '-q', '--no-verify', '-m', 'snapshot'], check=True)
        self.head = subprocess.run(self.git + ['rev-parse', 'HEAD'], capture_output=True, text=True,
                                   check=True).stdout.strip()

        self.bin = os.path.join(self.tmp, 'bin')
        self.state_dir = os.path.join(self.tmp, 'aws')
        os.makedirs(self.bin)
        os.makedirs(self.state_dir)
        for name, body in (('aws', FAKE_AWS), ('sf', FAKE_SF), ('gh', FAKE_GH), ('npm', FAKE_NPM), ('zip', FAKE_ZIP)):
            path = os.path.join(self.bin, name)
            with open(path, 'w') as f:
                f.write(body)
            os.chmod(path, 0o755)
        self.state = {'account': ACCOUNT, 'region': REGION, 'params': {},
                      'org': {'username': 'deploy@iot-dev.example.com', 'id': ORG_ID}}

    def write(self, name, text):
        path = os.path.join(self.repo, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            f.write(text)

    def param(self, name, value, kind='String'):
        self.state['params'][name] = {'name': name, 'type': kind, 'value': value}

    def run_script(self, script, *args, ci=False, **env_vars):
        with open(os.path.join(self.state_dir, 'state.json'), 'w') as f:
            json.dump(self.state, f)
        env = {k: v for k, v in os.environ.items()
               if k not in ('GITHUB_ACTIONS', 'AWS_PROFILE', 'ALLOW_DIRTY', 'ALLOW_LOCAL_PROD', 'ALLOW_UNPAIRED_ORG',
                            'SF_TARGET_ORG', 'ALARM_EMAIL', 'GITHUB_REPO', 'GITHUB_OIDC', 'BUDGET_USD', 'BUDGET_EMAIL')
               and not k.startswith(('SF_INTEGRATION_', 'SF_LOGIN_URL', 'SLACK_', 'DATA_CLOUD_'))}
        env.update(PATH=self.bin + os.pathsep + os.environ['PATH'], AWS_REGION=REGION, FAKE_AWS_STATE=self.state_dir)
        if ci:
            env['GITHUB_ACTIONS'] = 'true'
        env.update(env_vars)
        result = subprocess.run([os.path.join(self.repo, 'scripts', script), *args], cwd=self.repo, env=env,
                                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
        with open(os.path.join(self.state_dir, 'state.json')) as f:
            self.after = json.load(f)
        return result.returncode, result.stdout + result.stderr

    def lines(self, name):
        path = os.path.join(self.state_dir, name)
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return [json.loads(line) for line in f]

    def calls(self, name=None):
        return [c for c in self.lines('calls.jsonl') if name is None or c['call'] == name]

    def puts(self):
        return [c['options']['name'][0] for c in self.calls('ssm put-parameter')]

    def value(self, name):
        return self.after['params'][name]['value']


class SeedSsm(SetupFixture):

    def test_a_brand_new_environment_gets_placeholders_so_everything_can_deploy(self):
        code, out = self.run_script('seed-ssm.sh', 'Dev', ci=True)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.value(LABEL), 'Dev')
        for name in ('consumer-key', 'username', 'jwt-private-key'):
            self.assertEqual(self.value(f'{SF}/{name}'), 'placeholder', name)
        self.assertEqual(self.after['params'][f'{SF}/jwt-private-key']['type'], 'SecureString')
        self.assertEqual(self.value(f'{SF}/login-url'), 'https://login.salesforce.com')
        self.assertNotIn('/cloud-agentic-iot/slack/signing-secret', self.after['params'])
        self.assertIn('placeholder', out)

    def test_the_account_label_is_checked_before_anything_is_written(self):
        self.param(LABEL, 'Prod')
        code, out = self.run_script('seed-ssm.sh', 'Dev', ci=True, SF_INTEGRATION_USERNAME='integration@x')
        self.assertNotEqual(code, 0)
        self.assertIn('labelled Prod, not Dev', out)
        self.assertEqual(self.puts(), [])

    def test_the_first_write_into_a_fresh_account_is_its_label(self):
        code, out = self.run_script('seed-ssm.sh', 'Dev', ci=True)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.puts()[0], LABEL)

    def test_real_values_are_written_and_never_pass_through_the_command_line(self):
        code, out = self.run_script(
            'seed-ssm.sh', 'Dev', ci=True,
            SF_INTEGRATION_CONSUMER_KEY='consumer-key-value', SF_INTEGRATION_USERNAME='integration@iot-dev.example.com',
            SF_INTEGRATION_JWT_KEY=base64.b64encode(PEM.encode()).decode(), SLACK_SIGNING_SECRET='slack-value',
            SF_LOGIN_URL='https://example.my.salesforce.com')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.value(f'{SF}/consumer-key'), 'consumer-key-value')
        self.assertEqual(self.value(f'{SF}/username'), 'integration@iot-dev.example.com')
        self.assertEqual(self.value(f'{SF}/login-url'), 'https://example.my.salesforce.com')
        self.assertEqual(self.value(f'{SF}/jwt-private-key'), PEM)
        self.assertEqual(self.value('/cloud-agentic-iot/slack/signing-secret'), 'slack-value')
        for call in self.calls('ssm put-parameter'):
            if call['options']['name'][0] != LABEL:
                self.assertTrue(call['raw_value'].startswith('file://'), call)
        for secret in ('consumer-key-value', 'slack-value', 'not-a-real-key'):
            self.assertNotIn(secret, out)
        self.assertNotIn('placeholder', out)

    def test_a_key_file_works_as_well_as_the_base64_secret(self):
        self.write('integration.pem', PEM)
        code, out = self.run_script('seed-ssm.sh', 'Dev', SF_INTEGRATION_JWT_KEY_FILE='integration.pem')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.value(f'{SF}/jwt-private-key'), PEM)

    def test_values_already_in_ssm_are_never_replaced_by_placeholders(self):
        self.param(LABEL, 'Dev')
        self.param(f'{SF}/consumer-key', 'real-key')
        self.param(f'{SF}/username', 'integration@x')
        self.param(f'{SF}/login-url', 'https://example.my.salesforce.com')
        self.param(f'{SF}/jwt-private-key', PEM, 'SecureString')
        code, out = self.run_script('seed-ssm.sh', 'Dev', ci=True)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.puts(), [])
        self.assertEqual(self.value(f'{SF}/consumer-key'), 'real-key')
        self.assertEqual(self.value(f'{SF}/login-url'), 'https://example.my.salesforce.com')

    def test_a_parameter_whose_type_changed_is_replaced_once(self):
        self.param(LABEL, 'Dev')
        self.param(f'{SF}/jwt-private-key', 'old', 'String')
        code, out = self.run_script('seed-ssm.sh', 'Dev', ci=True,
                                    SF_INTEGRATION_JWT_KEY=base64.b64encode(PEM.encode()).decode())
        self.assertEqual(code, 0, out)
        self.assertEqual([c['options']['name'][0] for c in self.calls('ssm delete-parameter')], [f'{SF}/jwt-private-key'])
        self.assertEqual(self.after['params'][f'{SF}/jwt-private-key']['type'], 'SecureString')

    def test_a_key_that_is_not_a_private_key_is_refused(self):
        code, out = self.run_script('seed-ssm.sh', 'Dev', ci=True,
                                    SF_INTEGRATION_JWT_KEY=base64.b64encode(b'a certificate').decode())
        self.assertNotEqual(code, 0)
        self.assertIn('not a PEM private key', out)
        self.assertNotIn(f'{SF}/jwt-private-key', self.after['params'])

    def test_prod_is_seeded_by_the_pipeline_not_a_laptop(self):
        code, out = self.run_script('seed-ssm.sh', 'Prod')
        self.assertNotEqual(code, 0)
        self.assertIn('ALLOW_LOCAL_PROD=yes', out)
        self.assertEqual(self.calls(), [])


class DeploySalesforceGuards(SetupFixture):

    def setUp(self):
        super().setUp()
        self.param(LABEL, 'Dev')

    def deploys(self):
        return [args for args in self.lines('sf.jsonl') if args[:2] == ['project', 'deploy']]

    def test_the_first_deploy_pairs_the_org_with_the_account_and_records_the_commit(self):
        code, out = self.run_script('deploy-salesforce.sh', 'Dev', '--with-tests', SF_TARGET_ORG='test-org')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.value(f'{SF}/org-id'), ORG_ID)
        self.assertEqual(self.value('/cloud-agentic-iot/deployed-commit/salesforce'), self.head)
        # Validate with tests, follow it, then quick-deploy that validation:
        # the Apex tests run once.
        self.assertEqual([d[2] for d in self.deploys()], ['validate', 'resume', 'quick'])
        validate, resume, quick = self.deploys()
        # By manifest, removing what left force-app/ afterwards.
        self.assertEqual(validate[validate.index('--post-destructive-changes') + 1],
                         'manifest/destructiveChangesPost.xml')
        self.assertEqual(validate[validate.index('--test-level') + 1], 'RunLocalTests')
        self.assertEqual(resume[resume.index('--job-id') + 1], '0AfVALIDATION')
        self.assertEqual(quick[quick.index('--job-id') + 1], '0AfVALIDATION')

    def test_an_org_paired_with_another_account_is_refused_before_anything_deploys(self):
        self.param(f'{SF}/org-id', OTHER_ORG_ID)
        code, out = self.run_script('deploy-salesforce.sh', 'Dev', SF_TARGET_ORG='test-org')
        self.assertNotEqual(code, 0)
        self.assertIn('not the org paired with AWS account', out)
        self.assertEqual(self.deploys(), [])

    def test_a_region_the_account_denies_is_named_before_anything_deploys(self):
        # Nov 19: a profile in us-east-1 for an AWS project that allows only
        # us-east-2 hit an explicit SCP deny on the account label.
        self.state['scp_denies'] = True
        code, out = self.run_script('deploy-salesforce.sh', 'Dev', SF_TARGET_ORG='test-org')
        self.assertNotEqual(code, 0)
        self.assertIn(f'an organization policy denies it in {REGION}', out)
        self.assertIn('AWS_PROFILE', out)
        self.assertEqual(self.deploys(), [])

    def test_uncommitted_changes_are_refused_on_a_laptop(self):
        self.write('force-app/main/default/labels/CustomLabels.labels-meta.xml', '<CustomLabels>changed</CustomLabels>\n')
        code, out = self.run_script('deploy-salesforce.sh', 'Dev', SF_TARGET_ORG='test-org')
        self.assertNotEqual(code, 0)
        self.assertIn('ALLOW_DIRTY=yes', out)
        self.assertEqual(self.deploys(), [])
        self.assertEqual(self.calls(), [])

    def test_allow_dirty_deploys_and_says_so_in_the_recorded_commit(self):
        self.write('force-app/main/default/labels/CustomLabels.labels-meta.xml', '<CustomLabels>changed</CustomLabels>\n')
        code, out = self.run_script('deploy-salesforce.sh', 'Dev', SF_TARGET_ORG='test-org', ALLOW_DIRTY='yes')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.value('/cloud-agentic-iot/deployed-commit/salesforce'), f'{self.head}-dirty')

    def test_the_pipeline_deploys_its_checkout_as_it_is(self):
        self.write('scripts/untracked-note.txt', 'made by a step\n')
        code, out = self.run_script('deploy-salesforce.sh', 'Dev', ci=True, SF_TARGET_ORG='target-org')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.value('/cloud-agentic-iot/deployed-commit/salesforce'), self.head)

    def test_a_dry_run_checks_the_pairing_but_writes_nothing(self):
        code, out = self.run_script('deploy-salesforce.sh', 'Dev', '--dry-run', '--with-tests', SF_TARGET_ORG='test-org')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.puts(), [])
        self.assertEqual([d[2] for d in self.deploys()], ['validate', 'resume'])

    def test_a_laptop_deploy_to_dev_skips_apex_tests_in_one_deploy(self):
        code, out = self.run_script('deploy-salesforce.sh', 'Dev', SF_TARGET_ORG='test-org')
        self.assertEqual(code, 0, out)
        self.assertIn('Skipping Apex tests', out)
        (start,) = self.deploys()
        self.assertEqual(start[2], 'start')
        self.assertEqual(start[start.index('--test-level') + 1], 'NoTestRun')
        self.assertEqual(start[start.index('--post-destructive-changes') + 1], 'manifest/destructiveChangesPost.xml')
        self.assertEqual(self.value('/cloud-agentic-iot/deployed-commit/salesforce'), self.head)

    def test_a_laptop_dry_run_without_tests_validates_only(self):
        code, out = self.run_script('deploy-salesforce.sh', 'Dev', '--dry-run', SF_TARGET_ORG='test-org')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.puts(), [])
        (validate,) = self.deploys()
        self.assertEqual(validate[2], 'validate')
        self.assertEqual(validate[validate.index('--test-level') + 1], 'NoTestRun')

    def test_run_tests_yes_runs_them_like_with_tests(self):
        code, out = self.run_script('deploy-salesforce.sh', 'Dev', SF_TARGET_ORG='test-org', RUN_TESTS='yes')
        self.assertEqual(code, 0, out)
        self.assertEqual([d[2] for d in self.deploys()], ['validate', 'resume', 'quick'])

    def test_the_pipeline_always_runs_apex_tests(self):
        code, out = self.run_script('deploy-salesforce.sh', 'Dev', ci=True, SF_TARGET_ORG='target-org')
        self.assertEqual(code, 0, out)
        self.assertEqual([d[2] for d in self.deploys()], ['validate', 'resume', 'quick'])
        validate = self.deploys()[0]
        self.assertEqual(validate[validate.index('--test-level') + 1], 'RunLocalTests')

    def test_an_unknown_option_is_refused_before_anything_deploys(self):
        code, out = self.run_script('deploy-salesforce.sh', 'Dev', '--skip-tests', SF_TARGET_ORG='test-org')
        self.assertNotEqual(code, 0)
        self.assertIn('Unknown option', out)
        self.assertEqual(self.deploys(), [])

    def test_an_org_with_no_aws_side_can_skip_the_pairing(self):
        code, out = self.run_script('deploy-salesforce.sh', 'Dev', SF_TARGET_ORG='scratch', ALLOW_UNPAIRED_ORG='yes')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.calls(), [])
        self.assertIn('ALLOW_UNPAIRED_ORG=yes', out)


class DeployAws(SetupFixture):

    def setUp(self):
        super().setUp()
        self.param(LABEL, 'Dev')
        # What scripts/seed-ssm.sh leaves in a seeded account.
        for name in ('consumer-key', 'username', 'login-url'):
            self.param(f'{SF}/{name}', 'value')
        self.param(f'{SF}/jwt-private-key', PEM, 'SecureString')
        with open(os.path.join(self.repo, 'config', 'Dev.json')) as f:
            self.retention = json.load(f)['lambdaLogRetentionDays']
        declared = subprocess.run(['grep', '-rhoE', 'FunctionName: cloud-agentic-iot-[a-z-]+', '--include=cloudformation.yaml',
                                   self.repo], capture_output=True, text=True, check=True).stdout.split()
        self.functions = sorted({word for word in declared if word.startswith('cloud-agentic-iot-')})
        self.state['functions'] = self.functions
        self.state['outputs'] = {
            'cloud-agentic-iot-alarms-Dev': {'AlarmTopicArn': TOPIC},
            'cloud-agentic-iot-ota-Dev': {'FirmwareBucketName': OTA_BUCKET, 'OtaPresignRoleArn': OTA_ROLE},
        }
        self.state['log_groups'] = ['/aws/lambda/cloud-agentic-iot-patient-vitals']

    def overrides(self, stack):
        for call in self.calls('cloudformation deploy'):
            if call['options']['stack-name'] == [stack]:
                return call['options'].get('parameter-overrides', [])
        self.fail(f'{stack} was not deployed')

    def test_the_alarms_stack_deploys_first_and_every_stack_with_alarms_gets_its_topic(self):
        code, out = self.run_script('deploy-aws.sh', 'Dev', ALARM_EMAIL='oncall@example.com')
        self.assertEqual(code, 0, out)
        stacks = [c['options']['stack-name'][0] for c in self.calls('cloudformation deploy')]
        self.assertEqual(stacks[0], 'cloud-agentic-iot-alarms-Dev')
        self.assertIn('AlarmEmail=oncall@example.com', self.overrides('cloud-agentic-iot-alarms-Dev'))
        for stack in ('cloud-agentic-iot-patient-vitals-Dev', 'cloud-agentic-iot-streaming-Dev'):
            self.assertIn(f'AlarmTopicArn={TOPIC}', self.overrides(stack), stack)
        self.assertNotIn(f'AlarmTopicArn={TOPIC}', self.overrides('cloud-agentic-iot-queue-relay-Dev'))

    def test_the_ota_saga_gets_the_firmware_bucket_and_signing_role_of_the_ota_stack(self):
        code, out = self.run_script('deploy-aws.sh', 'Dev')
        self.assertEqual(code, 0, out)
        stacks = [c['options']['stack-name'][0] for c in self.calls('cloudformation deploy')]
        self.assertLess(stacks.index('cloud-agentic-iot-ota-Dev'), stacks.index('cloud-agentic-iot-ota-saga-Dev'))
        saga = self.overrides('cloud-agentic-iot-ota-saga-Dev')
        self.assertIn(f'FirmwareBucketName={OTA_BUCKET}', saga)
        self.assertIn(f'OtaPresignRoleArn={OTA_ROLE}', saga)
        self.assertFalse(any(o.startswith('FirmwareBucketName=') for o in self.overrides('cloud-agentic-iot-streaming-Dev')))

    def test_an_ota_stack_without_its_outputs_stops_the_deploy(self):
        self.state['outputs']['cloud-agentic-iot-ota-Dev'] = {}
        code, out = self.run_script('deploy-aws.sh', 'Dev')
        self.assertNotEqual(code, 0)
        self.assertIn('the OTA saga needs both', out)

    def test_without_alarm_email_the_address_the_stack_has_is_kept(self):
        code, out = self.run_script('deploy-aws.sh', 'Dev')
        self.assertEqual(code, 0, out)
        self.assertFalse(any(o.startswith('AlarmEmail=') for o in self.overrides('cloud-agentic-iot-alarms-Dev')))

    def test_what_data_cloud_reads_as_goes_only_to_the_stack_that_declares_it(self):
        provider = f'arn:aws:iam::{ACCOUNT}:oidc-provider/example.my.salesforce.com/services/connectors'
        code, out = self.run_script('deploy-aws.sh', 'Dev', DATA_CLOUD_READER_USER='cloud-agentic-iot-data-cloud-reader',
                                    DATA_CLOUD_OIDC_PROVIDER_ARN=provider, DATA_CLOUD_EXTERNAL_ID='app:0000:1111')
        self.assertEqual(code, 0, out)
        vitals = self.overrides('cloud-agentic-iot-patient-vitals-Dev')
        self.assertIn('DataCloudReaderUserName=cloud-agentic-iot-data-cloud-reader', vitals)
        self.assertIn(f'DataCloudOidcProviderArn={provider}', vitals)
        self.assertIn('DataCloudExternalId=app:0000:1111', vitals)
        for stack in ('cloud-agentic-iot-alarms-Dev', 'cloud-agentic-iot-queue-relay-Dev'):
            self.assertFalse(any(o.startswith('DataCloud') for o in self.overrides(stack)), stack)

    def test_without_data_cloud_names_the_stack_keeps_what_it_has(self):
        code, out = self.run_script('deploy-aws.sh', 'Dev')
        self.assertEqual(code, 0, out)
        vitals = self.overrides('cloud-agentic-iot-patient-vitals-Dev')
        self.assertFalse(any(o.startswith(('DataCloudReaderUserName=', 'DataCloudOidcProviderArn=', 'DataCloudExternalId='))
                             for o in vitals), vitals)
        # The CSV copy itself is configuration, from config/Dev.json.
        self.assertIn('DataCloudExport=true', vitals)

    def test_every_packaged_function_keeps_its_logs_for_the_configured_days(self):
        code, out = self.run_script('deploy-aws.sh', 'Dev')
        self.assertEqual(code, 0, out)
        kept = {c['options']['log-group-name'][0]: c['options']['retention-in-days'][0]
                for c in self.calls('logs put-retention-policy')}
        packaged = [c['options']['function-name'][0] for c in self.calls('lambda update-function-code')]
        self.assertTrue(packaged)
        self.assertEqual(sorted(kept), sorted(f'/aws/lambda/{fn}' for fn in packaged))
        self.assertEqual(set(kept.values()), {str(self.retention)})

    def test_the_guardrails_and_the_mcp_server_are_deployed_packaged_and_the_endpoint_printed(self):
        url = 'https://abc123.lambda-url.ca-central-1.on.aws/'
        role = f'arn:aws:iam::{ACCOUNT}:role/cloud-agentic-iot-mcp-server-Dev-McpClientRole-X'
        self.state['outputs']['cloud-agentic-iot-mcp-server-Dev'] = {'McpServerEndpoint': url, 'McpClientRoleArn': role}
        code, out = self.run_script('deploy-aws.sh', 'Dev')
        self.assertEqual(code, 0, out)
        stacks = [c['options']['stack-name'][0] for c in self.calls('cloudformation deploy')]
        self.assertIn('cloud-agentic-iot-guardrails-Dev', stacks)
        self.assertIn('cloud-agentic-iot-mcp-server-Dev', stacks)
        self.assertIn('MaxRoomsScanned=500', self.overrides('cloud-agentic-iot-mcp-server-Dev'))
        packaged = [c['options']['function-name'][0] for c in self.calls('lambda update-function-code')]
        self.assertIn('cloud-agentic-iot-guardrails', packaged)
        self.assertIn('cloud-agentic-iot-mcp-server', packaged)
        self.assertIn(f'MCP server: {url}', out)
        self.assertIn(role, out)

    def test_every_sop_is_indexed_after_the_functions_are_packaged(self):
        code, out = self.run_script('deploy-aws.sh', 'Dev')
        self.assertEqual(code, 0, out)
        invoked = self.lines('invoked.jsonl')
        self.assertEqual([i['function'] for i in invoked], ['cloud-agentic-iot-knowledge-indexer'])
        files = sorted(d['file'] for d in invoked[0]['payload']['documents'])
        on_disk = sorted(f'knowledge/sops/{name}' for name in os.listdir(os.path.join(self.repo, 'knowledge', 'sops'))
                         if name.endswith('.md'))
        self.assertEqual(files, on_disk)
        self.assertNotIn('force', invoked[0]['payload'])
        order = [c['call'] for c in self.calls()]
        self.assertLess(max(i for i, c in enumerate(order) if c == 'lambda update-function-code'),
                        order.index('lambda invoke'))
        self.assertIn('indexed: 7 SOP(s), 24 passage(s)', out)

    def test_a_failed_index_fails_the_deploy_and_says_why(self):
        self.state['invoke_answer'] = {'ok': False, 'problems': ['knowledge/sops/x.md: front matter has no owner']}
        code, out = self.run_script('deploy-aws.sh', 'Dev')
        self.assertNotEqual(code, 0)
        self.assertIn('front matter has no owner', out)
        self.state['invoke_answer'] = {'errorMessage': 'AccessDeniedException', 'errorType': 'AccessDeniedException'}
        self.state['invoke_error'] = True
        code, out = self.run_script('deploy-aws.sh', 'Dev')
        self.assertNotEqual(code, 0)
        self.assertIn('Titan Text Embeddings V2', out)

    def test_a_bad_sop_stops_the_index_before_any_aws_call(self):
        self.write('knowledge/sops/SOP-WARD-099-broken.md', '---\nid: SOP-WARD-099\ntitle: Broken\n---\n\n## Steps\n\n1. x\n')
        code, out = self.run_script('index-sops.sh', 'Dev')
        self.assertNotEqual(code, 0)
        self.assertIn('SOP-WARD-099-broken.md: front matter has no version', out)
        self.assertEqual(self.calls(), [])

    def test_index_sops_on_its_own_checks_the_account_and_can_force_a_rebuild(self):
        code, out = self.run_script('index-sops.sh', 'Dev', '--force')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.calls()[0]['call'], 'sts get-caller-identity')
        self.assertTrue(self.lines('invoked.jsonl')[0]['payload']['force'])

    def test_the_deployed_commit_is_recorded(self):
        code, out = self.run_script('deploy-aws.sh', 'Dev')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.value('/cloud-agentic-iot/deployed-commit/aws'), self.head)

    def test_uncommitted_changes_are_refused_before_any_aws_call(self):
        self.write('lambda/shared/scratch.js', '// not committed\n')
        code, out = self.run_script('deploy-aws.sh', 'Dev')
        self.assertNotEqual(code, 0)
        self.assertIn('ALLOW_DIRTY=yes', out)
        self.assertEqual(self.calls(), [])

    def test_missing_salesforce_settings_point_to_seed_ssm(self):
        del self.state['params'][f'{SF}/username']
        code, out = self.run_script('deploy-aws.sh', 'Dev')
        self.assertNotEqual(code, 0)
        self.assertIn('scripts/seed-ssm.sh Dev', out)
        self.assertEqual(self.calls('cloudformation deploy'), [])


class BootstrapAws(SetupFixture):

    STACK = 'cloud-agentic-iot-bootstrap-Dev'

    def overrides(self):
        [deploy] = self.calls('cloudformation deploy')
        self.assertEqual(deploy['options']['template-file'], ['infra/bootstrap/github-deploy.yaml'])
        self.assertEqual(deploy['options']['stack-name'], [self.STACK])
        return deploy['options']['parameter-overrides']

    def test_a_pipeline_account_gets_the_role_for_this_repository_and_a_budget(self):
        self.state['outputs'] = {self.STACK: {'DeployRoleArn': f'arn:aws:iam::{ACCOUNT}:role/github-actions-deploy'}}
        code, out = self.run_script('bootstrap-aws.sh', 'Dev', BUDGET_USD='25', BUDGET_EMAIL='me@example.com')
        self.assertEqual(code, 0, out)
        self.assertEqual(sorted(self.overrides()), sorted([
            'Environment=Dev', 'CreateGitHubDeploy=true', 'GitHubOwner=ExampleOwner', 'GitHubRepoName=cloud-agentic-iot',
            'GitHubOwnerId=1001', 'GitHubRepoId=2002', 'MonthlyBudgetUsd=25', 'BudgetEmail=me@example.com']))
        self.assertIn('role/github-actions-deploy', out)
        self.assertEqual(self.value(LABEL), 'Dev')

    def test_a_spend_limited_project_gets_only_the_budget(self):
        code, out = self.run_script('bootstrap-aws.sh', 'Dev', GITHUB_OIDC='no', BUDGET_USD='20')
        self.assertEqual(code, 0, out)
        self.assertEqual(sorted(self.overrides()), ['CreateGitHubDeploy=false', 'Environment=Dev', 'MonthlyBudgetUsd=20'])
        self.assertEqual(self.lines('gh.jsonl'), [])
        self.assertEqual(self.calls('iam list-open-id-connect-providers'), [])

    def test_a_provider_this_stack_did_not_create_must_be_named(self):
        provider = f'arn:aws:iam::{ACCOUNT}:oidc-provider/token.actions.githubusercontent.com'
        self.state['oidc_provider'] = provider
        code, out = self.run_script('bootstrap-aws.sh', 'Dev', BUDGET_USD='20')
        self.assertNotEqual(code, 0)
        self.assertIn(f'EXISTING_OIDC_PROVIDER_ARN={provider}', out)
        self.assertEqual(self.calls('cloudformation deploy'), [])

        self.state['outputs'] = {self.STACK: {'DeployRoleArn': f'arn:aws:iam::{ACCOUNT}:role/github-actions-deploy'}}
        code, out = self.run_script('bootstrap-aws.sh', 'Dev', EXISTING_OIDC_PROVIDER_ARN=provider)
        self.assertEqual(code, 0, out)
        self.assertIn(f'ExistingProviderArn={provider}', self.overrides())

    def test_the_wrong_account_is_refused_before_the_stack_deploys(self):
        self.param(LABEL, 'Prod')
        code, out = self.run_script('bootstrap-aws.sh', 'Dev', BUDGET_USD='20')
        self.assertNotEqual(code, 0)
        self.assertIn('labelled Prod, not Dev', out)
        self.assertEqual(self.calls('cloudformation deploy'), [])


if __name__ == '__main__':
    unittest.main()
