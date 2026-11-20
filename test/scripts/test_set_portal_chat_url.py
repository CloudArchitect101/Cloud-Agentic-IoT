"""scripts/set-portal-chat-url.sh: the one per-org portal value, set without touching force-app."""
import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
URL = 'https://example.my.site.com/ESWPatientPortalChat1700000000000'

# Keeps what the script hands to `sf project deploy start --metadata-dir`.
FAKE_SF = textwrap.dedent(r'''
    #!/usr/bin/env python3
    import os, shutil, sys
    args = sys.argv[1:]
    out = os.environ['FAKE_STATE']
    open(os.path.join(out, 'calls.log'), 'a').write(' '.join(args) + '\n')
    if args[:3] == ['project', 'deploy', 'start']:
        shutil.copytree(args[args.index('--metadata-dir') + 1], os.path.join(out, 'deployed'))
        sys.exit(0)
    sys.stderr.write('fake sf: unexpected call\n'); sys.exit(2)
    ''').lstrip()


class SetPortalChatUrlTest(unittest.TestCase):
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

    def run_script(self, *args):
        env = dict(os.environ, PATH=self.bin + os.pathsep + os.environ['PATH'], FAKE_STATE=self.state)
        return subprocess.run(['bash', os.path.join(REPO, 'scripts', 'set-portal-chat-url.sh'), *args],
                              env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL)

    def deployed(self, name):
        with open(os.path.join(self.state, 'deployed', name)) as f:
            return f.read()

    def calls(self):
        path = os.path.join(self.state, 'calls.log')
        return open(path).read().splitlines() if os.path.exists(path) else []

    def test_deploys_a_record_that_names_only_the_chat_url(self):
        result = self.run_script('my-org', URL)
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.deployed('customMetadata/Patient_Portal_Setting.Default.md')
        # One field: every other setting keeps the org's value.
        self.assertEqual(record.count('<field>'), 1)
        self.assertIn('<field>Chat_Site_Url__c</field>', record)
        self.assertIn(f'<value xsi:type="xsd:string">{URL}</value>', record)
        self.assertIn('<members>Patient_Portal_Setting.Default</members>', self.deployed('package.xml'))
        self.assertIn('--target-org my-org', self.calls()[0])

    def test_a_trailing_slash_is_dropped(self):
        self.assertEqual(self.run_script('my-org', URL + '/').returncode, 0)
        self.assertIn(f'>{URL}</value>', self.deployed('customMetadata/Patient_Portal_Setting.Default.md'))

    def test_a_dry_run_validates_only(self):
        self.assertEqual(self.run_script('my-org', URL, '--dry-run').returncode, 0)
        self.assertIn('--dry-run', self.calls()[0])

    def test_refuses_what_is_not_a_chat_site_url_before_any_call(self):
        for bad in ('http://example.my.site.com/ESWChat', 'https://example.my.site.com/patientPortal',
                    'https://example.my.site.com/ESW<x>', 'https://example.my.site.com/ESW chat', ''):
            result = self.run_script('my-org', bad)
            self.assertNotEqual(result.returncode, 0, bad)
        self.assertEqual(self.calls(), [])

    def test_the_repo_record_still_leaves_the_field_out(self):
        # The pair to this script: if force-app named the field, the next deploy would undo it.
        with open(os.path.join(REPO, 'force-app/main/default/customMetadata/Patient_Portal_Setting.Default.md-meta.xml')) as f:
            self.assertNotIn('<field>Chat_Site_Url__c</field>', f.read())


if __name__ == '__main__':
    unittest.main()
