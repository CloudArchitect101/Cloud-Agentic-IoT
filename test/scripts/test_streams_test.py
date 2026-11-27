"""
Tests for scripts/streams-test.sh against a fake AWS CLI: the synthetic
reading it sends down the chapter 02 stream, and what it refuses.

The fake `aws` logs every call and answers only the calls the script makes;
a fake `sleep` keeps the dispatcher wait instant.

Run with: python3 -m unittest discover -s test/scripts
"""

import json
import os
import subprocess
import tempfile
import textwrap
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPT = os.path.join(REPO, 'scripts', 'streams-test.sh')

FAKE_AWS = textwrap.dedent(r'''
    #!/usr/bin/env python3
    import json, os, sys
    state_dir = os.environ['FAKE_AWS_STATE']
    state = json.load(open(os.path.join(state_dir, 'state.json')))
    args = sys.argv[1:]
    call = ' '.join(args[:2])
    with open(os.path.join(state_dir, 'calls.jsonl'), 'a') as f:
        f.write(json.dumps(args) + '\n')
    def opt(name):
        return args[args.index('--' + name) + 1] if '--' + name in args else None
    if call == 'sts get-caller-identity':
        print('111122223333\tarn:aws:sts::111122223333:assumed-role/Admin/tester')
    elif call == 'configure get':
        print('us-east-2')
    elif call == 'ssm get-parameter':
        print(state['label'])
    elif call == 'lambda get-function':
        sys.exit(0 if state.get('router', True) else 254)
    elif call == 'lambda invoke':
        payload = open(opt('payload')[len('fileb://'):]).read()
        open(os.path.join(state_dir, 'payload.json'), 'w').write(payload)
        json.dump({'statusCode': 200, 'body': '{"message":"Event routed successfully"}'}, open(args[-1], 'w'))
        print('{"StatusCode": 200}')
    elif call == 'logs filter-log-events':
        print(state.get('log', ''))
    else:
        sys.stderr.write('unexpected aws call: ' + ' '.join(args) + '\n')
        sys.exit(99)
''').lstrip()


class StreamsTest(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.bin = os.path.join(self.tmp, 'bin')
        os.mkdir(self.bin)
        for name, body in (('aws', FAKE_AWS), ('sleep', '#!/bin/sh\nexit 0\n')):
            path = os.path.join(self.bin, name)
            with open(path, 'w') as f:
                f.write(body)
            os.chmod(path, 0o755)

    def run_script(self, *args, label='Dev', log="Alert dispatched to Salesforce { deviceId: 'PatientExternalESP32', alertType: 'CRITICAL_VITALS' }", router=True):
        with open(os.path.join(self.tmp, 'state.json'), 'w') as f:
            json.dump({'label': label, 'log': log, 'router': router}, f)
        env = dict(os.environ, PATH=self.bin + os.pathsep + os.environ['PATH'], FAKE_AWS_STATE=self.tmp)
        env.pop('GITHUB_ACTIONS', None)
        env.pop('ALLOW_LOCAL_PROD', None)
        return subprocess.run(['bash', SCRIPT, *args], cwd=REPO, env=env, capture_output=True, text=True)

    def payload(self):
        return json.load(open(os.path.join(self.tmp, 'payload.json')))

    def test_a_critical_reading_goes_to_the_router_labelled_synthetic(self):
        result = self.run_script('Dev', 'PatientExternalESP32')
        self.assertEqual(result.returncode, 0, result.stderr)
        sent = self.payload()
        self.assertEqual(sent['deviceId'], 'PatientExternalESP32')
        self.assertEqual(sent['sourceSystem'], 'SYNTHETIC_TEST')
        thresholds = json.load(open(os.path.join(REPO, 'config', 'vital-thresholds.json')))
        hr = next(v for v in thresholds['vitals'] if v['field'] == 'heartRate')
        self.assertGreater(sent['heartRate'], hr['critical']['above'], 'critical must really be critical')
        self.assertIn('CRITICAL_VITALS', result.stdout)
        self.assertIn('Critical vitals on PatientExternalESP32', result.stdout)

    def test_a_normal_reading_is_inside_every_band(self):
        result = self.run_script('Dev', 'PatientExternalESP32', 'normal', log="No alert for device { deviceId: 'PatientExternalESP32' }")
        self.assertEqual(result.returncode, 0, result.stderr)
        thresholds = json.load(open(os.path.join(REPO, 'config', 'vital-thresholds.json')))
        sent = self.payload()
        for vital in thresholds['vitals']:
            value = sent.get(vital['field'])
            if value is None:
                continue
            warning = vital['warning']
            self.assertFalse(value < warning.get('below', float('-inf')) or value > warning.get('above', float('inf')), vital['field'])

    def test_prod_is_refused(self):
        result = self.run_script('Prod', 'PatientExternalESP32', label='Prod')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Send it to Dev', result.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, 'calls.jsonl')))

    def test_a_device_name_that_is_not_a_thing_name_is_refused(self):
        result = self.run_script('Dev', 'PatientExternalESP32","heartRate":0')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('is not a Thing name', result.stderr)

    def test_a_silent_dispatcher_fails_with_where_to_look(self):
        result = self.run_script('Dev', 'PatientExternalESP32', log='')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Nothing from cloud-agentic-iot-alert-dispatcher', result.stderr)

    def test_a_missing_router_says_to_deploy(self):
        result = self.run_script('Dev', 'PatientExternalESP32', router=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Deploy the streaming stack first', result.stderr)


if __name__ == '__main__':
    unittest.main()
