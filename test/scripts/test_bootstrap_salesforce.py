"""scripts/bootstrap-salesforce.sh: one-time setup that creates what is missing and never changes what exists."""
import json
import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
import xml.dom.minidom

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
URL = 'https://abc123.execute-api.us-east-2.amazonaws.com/Dev'
DUMMY_URL = 'https://dummy-replace-me.example.com'

# Answers "does the org have X" from state.json and keeps what is deployed.
FAKE_SF = textwrap.dedent(r'''
    #!/usr/bin/env python3
    import json, os, re, shutil, sys
    args = sys.argv[1:]
    out = os.environ['FAKE_STATE']
    state = json.load(open(os.path.join(out, 'state.json')))
    open(os.path.join(out, 'calls.log'), 'a').write(' '.join(args) + '\n')
    if args[:2] == ['data', 'query']:
        query = args[args.index('--query') + 1]
        kind = re.search(r'FROM (\w+)', query).group(1)
        name = re.search(r"= '([^']+)'", query).group(1)
        if state.get('query_fails') == kind:
            sys.stderr.write('INVALID_SESSION_ID\n'); sys.exit(1)
        if state.get('garbled') == kind:
            print('not json'); sys.exit(0)
        print(json.dumps({'result': {'totalSize': 1 if name in state.get(kind, []) else 0}}))
        sys.exit(0)
    if args[:3] == ['project', 'deploy', 'start']:
        shutil.copytree(args[args.index('--metadata-dir') + 1], os.path.join(out, 'deployed'))
        sys.exit(0)
    sys.stderr.write('fake sf: unexpected call\n'); sys.exit(2)
    ''').lstrip()


class BootstrapSalesforceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.state = os.path.join(self.tmp, 'state')
        self.bin = os.path.join(self.tmp, 'bin')
        os.makedirs(self.state)
        os.makedirs(self.bin)
        path = os.path.join(self.bin, 'sf')
        with open(path, 'w') as f:
            f.write(FAKE_SF)
        os.chmod(path, 0o755)
        self.org()

    def org(self, **state):
        """What the org has: ExternalCredential=[...], NamedCredential=[...], PermissionSet=[...]."""
        with open(os.path.join(self.state, 'state.json'), 'w') as f:
            json.dump(state, f)

    def run_script(self, *args, **extra_env):
        env = {k: v for k, v in os.environ.items() if k != 'GITHUB_ACTIONS'}
        env.update(PATH=self.bin + os.pathsep + os.environ['PATH'], FAKE_STATE=self.state, **extra_env)
        return subprocess.run(['bash', os.path.join(REPO, 'scripts', 'bootstrap-salesforce.sh'), *args],
                              env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL)

    def deployed(self, name=None):
        root = os.path.join(self.state, 'deployed')
        if name is None:
            if not os.path.isdir(root):
                return None
            return sorted(os.path.relpath(os.path.join(d, f), root) for d, _, files in os.walk(root) for f in files)
        with open(os.path.join(root, name)) as f:
            return f.read()

    def calls(self):
        path = os.path.join(self.state, 'calls.log')
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return f.read().splitlines()

    def test_an_empty_org_gets_all_three_with_placeholders(self):
        result = self.run_script('my-org')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.deployed(), [
            'externalCredentials/AWS_IoT_Relay_Credential.externalCredential',
            'namedCredentials/AWS_IoT_Relay.namedCredential',
            'package.xml',
            'permissionsets/AWS_IoT_Relay_Callers.permissionset',
        ])
        self.assertIn('>us-east-1<', self.deployed('externalCredentials/AWS_IoT_Relay_Credential.externalCredential'))
        self.assertIn(DUMMY_URL, self.deployed('namedCredentials/AWS_IoT_Relay.namedCredential'))
        package = self.deployed('package.xml')
        for kind in ('ExternalCredential', 'NamedCredential', 'PermissionSet'):
            self.assertIn(f'<name>{kind}</name>', package)
        self.assertIn('--target-org my-org', self.calls()[-1])
        # It says what is left for a person, and the key is one of those things.
        self.assertIn('STS Access Key', result.stdout)
        self.assertIn('IAM Role ARN', result.stdout)
        self.assertIn(DUMMY_URL, result.stdout)

    def test_every_file_is_well_formed_xml_before_and_after_staging(self):
        # A fake sf accepts anything; Salesforce does not. "--" in a comment is enough to be refused.
        source = os.path.join(REPO, 'bootstrap', 'salesforce')
        found = [os.path.join(d, f) for d, _, files in os.walk(source) for f in files if f.endswith('.xml')]
        self.assertEqual(len(found), 3)
        for path in found:
            xml.dom.minidom.parse(path)
        self.assertEqual(self.run_script('my-org', '--url', URL, '--region', 'us-east-2').returncode, 0)
        for name in self.deployed():
            xml.dom.minidom.parse(os.path.join(self.state, 'deployed', name))

    def test_real_values_replace_the_placeholders(self):
        result = self.run_script('my-org', '--url', URL + '/', '--region', 'us-east-2')
        self.assertEqual(result.returncode, 0, result.stderr)
        external = self.deployed('externalCredentials/AWS_IoT_Relay_Credential.externalCredential')
        self.assertNotIn('>us-east-1<', external)
        self.assertIn('>us-east-2<', external)
        named = self.deployed('namedCredentials/AWS_IoT_Relay.namedCredential')
        self.assertIn(f'>{URL}<', named)
        self.assertNotIn('dummy', named)
        self.assertNotIn('dummy', result.stdout)
        # The role ARN and the key are never the script's to set.
        self.assertIn('IAM Role ARN', result.stdout)

    def test_an_org_that_has_everything_is_not_touched(self):
        self.org(ExternalCredential=['AWS_IoT_Relay_Credential'], NamedCredential=['AWS_IoT_Relay'],
                 PermissionSet=['AWS_IoT_Relay_Callers'])
        result = self.run_script('my-org', '--url', URL)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(self.deployed())
        self.assertFalse(any('deploy' in call for call in self.calls()))
        self.assertIn('Nothing was changed', result.stdout)

    def test_a_working_named_credential_keeps_its_external_credential_whatever_its_name(self):
        # The org's external credential has another name; nothing of ours may
        # be created beside it, and the set that names our principal cannot be.
        self.org(NamedCredential=['AWS_IoT_Relay'])
        result = self.run_script('my-org')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(self.deployed())
        self.assertIn('step 7d', result.stderr)

    def test_only_the_missing_permission_set_is_created(self):
        self.org(ExternalCredential=['AWS_IoT_Relay_Credential'], NamedCredential=['AWS_IoT_Relay'])
        result = self.run_script('my-org')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.deployed(), ['package.xml', 'permissionsets/AWS_IoT_Relay_Callers.permissionset'])
        package = self.deployed('package.xml')
        self.assertNotIn('ExternalCredential', package)
        self.assertNotIn('NamedCredential', package)

    def test_only_the_missing_named_credential_is_created(self):
        self.org(ExternalCredential=['AWS_IoT_Relay_Credential'], PermissionSet=['AWS_IoT_Relay_Callers'])
        result = self.run_script('my-org')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.deployed(), ['namedCredentials/AWS_IoT_Relay.namedCredential', 'package.xml'])

    def test_a_query_that_fails_deploys_nothing(self):
        for state in ({'query_fails': 'NamedCredential'}, {'garbled': 'PermissionSet'},
                      {'query_fails': 'ExternalCredential'}):
            with self.subTest(state=state):
                self.org(**state)
                result = self.run_script('my-org')
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(self.deployed())
                self.assertIn('nothing was deployed', result.stderr)

    def test_the_pipeline_cannot_run_it(self):
        result = self.run_script('my-org', GITHUB_ACTIONS='true')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [])
        self.assertIn('pipeline', result.stdout + result.stderr)

    def test_a_dry_run_validates_only(self):
        result = self.run_script('my-org', '--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--dry-run', self.calls()[-1])
        self.assertIn('was not changed', result.stdout)
        self.assertNotIn('STS Access Key', result.stdout)

    def test_bad_values_are_refused_before_the_org_is_asked(self):
        for args in (
            ('my-org', '--role-arn', 'arn:aws:iam::123456789012:role/some-role'),
            ('my-org', '--url', URL + '</parameterValue>'),
            ('my-org', '--url', 'http://abc.example.com/Dev'),
            ('my-org', '--url', URL + '|x'),
            ('my-org', '--region', 'US-EAST-2'),
            ('my-org', '--access-key', 'AKIAIOSFODNN7EXAMPLE'),
            ('--dry-run',),
            (),
        ):
            with self.subTest(args=args):
                result = self.run_script(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.calls(), [])


if __name__ == '__main__':
    unittest.main()
