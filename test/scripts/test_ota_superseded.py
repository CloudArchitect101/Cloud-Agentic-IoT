"""
Tests that `scripts/ota.sh release` and `promote` cancel the earlier jobs of
their own kind that boards have not started, against the same fake AWS CLI as
test_ota_try.py.

A board takes its jobs oldest first, so without this a board that was offline
while two releases went out installs the older one, then the newer one.

Run with: python3 -m unittest discover -s test/scripts
"""

import os
import unittest

from test_ota_try import ScriptFixture, ROLE, BUCKET, VERSION_RE

PM = 'patient-monitor'
QI = 'queue-indicator'


class SupersededFixture(ScriptFixture):

    def setUp(self):
        super().setUp()
        with open(os.path.join(self.repo, 'firmware', QI, f'{QI}.ino')) as f:
            self.qi = VERSION_RE.search(f.read()).group(1)
        # This version of the patient monitor is new; the queue indicator's is
        # already out, so a release publishes one sketch.
        self.state['objects'] = [f'firmware/{QI}/{self.qi}.bin']

    def run_ota(self, *args, **kwargs):
        return self.run_script(os.path.join(self.repo, 'scripts', 'ota.sh'), *args, ci=True, **kwargs)

    def job(self, job_id, group, status='IN_PROGRESS'):
        return {'jobId': job_id, 'status': status, 'group': group}

    def cancelled(self):
        return [c['options']['job-id'] for c in self.calls('iot cancel-job')]


class ReleaseTest(SupersededFixture):

    def test_a_dev_release_cancels_the_earlier_releases_boards_have_not_started(self):
        older = 'ota-patient-monitor-2-6-0-1793900000'
        self.state['jobs'] = [
            self.job(older, f'fleet-{PM}'),
            self.job('ota-patient-monitor-2-5-0-1793800000', f'fleet-{PM}', 'COMPLETED'),
            self.job('ota-try-patient-monitor-2-7-0-try-1-1793900100', f'fleet-{PM}'),
            self.job('ota-fleet-patient-monitor-2-6-0-1793900200', f'fleet-{PM}'),
            self.job('interval-patient-monitor-60-1793900300', f'fleet-{PM}'),
            self.job('ota-queue-indicator-2-1-0-1793900400', f'fleet-{QI}'),
        ]
        code, out = self.run_ota('release', 'Dev')
        self.assertEqual(code, 0, out)
        [job] = self.calls('iot create-job')
        new = job['options']['job-id']
        self.assertTrue(new.startswith(f"ota-{PM}-{self.base.replace('.', '-')}-"), new)
        self.assertEqual(self.cancelled(), [older], 'a try, a promotion, an interval and another type are left alone')
        [cancel] = self.calls('iot cancel-job')
        self.assertEqual(cancel['options']['comment'], f'Replaced by {new}')
        self.assertNotIn('force', cancel['options'], 'a board already installing it finishes')
        self.assertIn(f'Cancelled the earlier release {older}', out)
        self.assertIn(f'ota-metric superseded_jobs_cancelled=1 kind=release group=fleet-{PM}', out)

    def test_cancels_only_after_the_new_job_exists(self):
        self.state['jobs'] = [self.job('ota-patient-monitor-2-6-0-1793900000', f'fleet-{PM}')]
        code, out = self.run_ota('release', 'Dev')
        self.assertEqual(code, 0, out)
        order = [c['call'] for c in self.calls() if c['call'] in ('iot create-job', 'iot cancel-job')]
        self.assertEqual(order, ['iot create-job', 'iot cancel-job'])

    def test_a_prod_release_cancels_within_the_canary_ring(self):
        self.state['label'] = 'Prod'
        self.state['stacks'] = {'cloud-agentic-iot-ota-Prod': {'FirmwareBucketName': BUCKET, 'OtaPresignRoleArn': ROLE}}
        older = 'ota-patient-monitor-2-6-0-1793900000'
        self.state['jobs'] = [self.job(older, f'canary-{PM}'),
                              self.job('ota-fleet-patient-monitor-2-6-0-1793900100', f'fleet-{PM}')]
        code, out = self.run_ota('release', 'Prod')
        self.assertEqual(code, 0, out)
        [job] = self.calls('iot create-job')
        self.assertTrue(job['options']['targets'].endswith(f'thinggroup/canary-{PM}'))
        self.assertEqual(self.cancelled(), [older], 'the fleet keeps the promotion it was given')

    def test_nothing_to_cancel_says_nothing(self):
        code, out = self.run_ota('release', 'Dev')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.cancelled(), [])
        self.assertNotIn('ota-metric', out)

    def test_a_release_still_ships_when_the_old_jobs_cannot_be_cancelled(self):
        self.state['jobs'] = [self.job('ota-patient-monitor-2-6-0-1793900000', f'fleet-{PM}')]
        before = dict(self.state)
        for failure, says in (('cancel_fails', 'Could not cancel the earlier release'),
                              ('list_jobs_fails', 'Could not list the earlier releases')):
            with self.subTest(failure=failure):
                self.forget_calls()
                self.state = dict(before, **{failure: True})
                code, out = self.run_ota('release', 'Dev')
                self.assertEqual(code, 0, out)
                self.assertIn(says, out)
                self.assertEqual(len(self.calls('iot create-job')), 1)
                self.assertNotIn('ota-metric', out)

    def test_a_merge_with_no_new_version_cancels_nothing(self):
        self.state['objects'].append(f'firmware/{PM}/{self.base}.bin')
        self.state['jobs'] = [self.job('ota-patient-monitor-2-6-0-1793900000', f'fleet-{PM}')]
        code, out = self.run_ota('release', 'Dev')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.calls('iot create-job'), [])
        self.assertEqual(self.cancelled(), [], 'the job for the newest build keeps going')


class PromoteTest(SupersededFixture):

    def setUp(self):
        super().setUp()
        self.version = self.base
        self.canary = f"ota-{PM}-{self.version.replace('.', '-')}-1793900000"
        self.state['label'] = 'Prod'
        self.state['stacks'] = {'cloud-agentic-iot-ota-Prod': {'FirmwareBucketName': BUCKET, 'OtaPresignRoleArn': ROLE}}
        self.state['objects'].append(f'firmware/{PM}/{self.version}.bin')
        self.state['job_details'] = {self.canary: {'numberOfSucceededThings': 2}}

    def test_a_promotion_cancels_the_earlier_promotions_to_the_fleet(self):
        older = 'ota-fleet-patient-monitor-2-6-0-1793800000'
        self.state['jobs'] = [
            self.job(self.canary, f'canary-{PM}', 'COMPLETED'),
            self.job(older, f'fleet-{PM}'),
            self.job('interval-patient-monitor-60-1793800100', f'fleet-{PM}'),
            self.job('ota-fleet-queue-indicator-2-1-0-1793800200', f'fleet-{QI}'),
        ]
        code, out = self.run_ota('promote', 'Prod', PM, self.version)
        self.assertEqual(code, 0, out)
        [job] = self.calls('iot create-job')
        self.assertTrue(job['options']['job-id'].startswith(f'ota-fleet-{PM}-'))
        self.assertEqual(self.cancelled(), [older])
        self.assertIn(f'Cancelled the earlier promotion {older}', out)


if __name__ == '__main__':
    unittest.main()
