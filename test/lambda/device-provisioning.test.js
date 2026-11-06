'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadWithFakes, fakeAwsSdk, awsError, captureConsole, withEnv } = require('../helpers/fakes');

const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----';
const OLD_CERT_ARN = 'arn:aws:iot:ca-central-1:111122223333:cert/old123';
const POLICY = 'cloud-agentic-iot-device';

const ENV = {
  BUNDLE_BUCKET: 'bundles-bucket',
  IOT_POLICY_NAME: POLICY,
  DEFAULT_THING_GROUP: 'fleet-patient-monitor',
  DEFAULT_BUNDLE_TTL_MINUTES: '15',
  IOT_PARALLEL_REQUESTS: '4',
};

const IOT_COMMANDS = [
  'CreateThingCommand', 'ListThingPrincipalsCommand', 'CreateKeysAndCertificateCommand', 'AttachPolicyCommand',
  'AttachThingPrincipalCommand', 'ListThingGroupsForThingCommand', 'AddThingToThingGroupCommand',
  'RemoveThingFromThingGroupCommand', 'DescribeEndpointCommand',
  'ListAttachedPoliciesCommand', 'DetachPolicyCommand', 'DetachThingPrincipalCommand',
  'UpdateCertificateCommand', 'DeleteCertificateCommand',
];

/**
 * A fake IoT control plane. `principals` is what each Thing already has
 * attached, `groups` the Thing Groups it is already in; `fail(command, input)`
 * may throw to make one call fail.
 */
function iotFor({ principals = {}, groups = {}, fail = () => {} } = {}) {
  let certificates = 0;
  return (command, input) => {
    fail(command, input);
    switch (command) {
      case 'CreateThingCommand':
        return { thingArn: `arn:aws:iot:ca-central-1:111122223333:thing/${input.thingName}` };
      case 'ListThingPrincipalsCommand':
        return { principals: principals[input.thingName] || [] };
      case 'ListThingGroupsForThingCommand':
        return { thingGroups: (groups[input.thingName] || []).map((groupName) => ({ groupName })) };
      case 'CreateKeysAndCertificateCommand':
        certificates += 1;
        return {
          certificateArn: `arn:aws:iot:ca-central-1:111122223333:cert/new${certificates}`,
          certificateId: `new${certificates}`,
          certificatePem: '-----BEGIN CERTIFICATE-----\nnew\n-----END CERTIFICATE-----',
          keyPair: { PrivateKey: PRIVATE_KEY },
        };
      case 'DescribeEndpointCommand':
        return { endpointAddress: 'example-ats.iot.ca-central-1.amazonaws.com' };
      case 'ListAttachedPoliciesCommand':
        // The policy the README had people create by hand, before the template made one.
        return { policies: [{ policyName: 'ESP32-Patient-Monitor-Policy' }] };
      default:
        return {};
    }
  };
}

function load(t, name, iotOptions, { failS3 = () => {} } = {}) {
  withEnv(t, ENV);
  const iot = fakeAwsSdk('IoTClient', IOT_COMMANDS, iotFor(iotOptions));
  const s3 = fakeAwsSdk('S3Client', ['PutObjectCommand', 'GetObjectCommand'], (command) => {
    failS3(command);
    return {};
  });
  const signed = [];
  const presigner = {
    getSignedUrl: async (client, command, options) => {
      signed.push({ command: command.constructor.name, input: command.input, options });
      return `https://bundles-bucket.s3.amazonaws.com/signed/${signed.length}`;
    },
  };
  const { handler } = loadWithFakes(path.join(__dirname, `../../lambda/${name}/index.js`), {
    '@aws-sdk/client-iot': iot.sdk,
    '@aws-sdk/client-s3': s3.sdk,
    '@aws-sdk/s3-request-presigner': presigner,
  });
  const callsOf = (command) => iot.calls.filter((c) => c.command === command);
  return { handler, iot: iot.calls, callsOf, s3: s3.calls, signed };
}

const devices = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  thingName: `pm-${i + 1}`, ssid: 'clinic', passphrase: 'secret', ...extra,
}));
const apiRequest = (body) => ({ body: JSON.stringify(body) });   // as API Gateway delivers it
const resultsOf = (res) => JSON.parse(res.body).results;

for (const name of ['device-provisioning', 'device-reprovision']) {
  test(`${name}: the bundle link is signed for download, for the object just written`, async (t) => {
    const logs = captureConsole(t);
    const { handler, s3, signed } = load(t, name, { principals: { 'pm-1': name === 'device-reprovision' ? [OLD_CERT_ARN] : [] } });

    const res = await handler(apiRequest({ devices: devices(1), ttlMinutes: 10 }));

    assert.equal(res.statusCode, 200);
    assert.equal(s3.length, 1);
    assert.equal(s3[0].command, 'PutObjectCommand');
    // Used to be a PutObject URL: it could not download the bundle, and let
    // whoever held it overwrite the bundle.
    assert.equal(signed.length, 1);
    assert.equal(signed[0].command, 'GetObjectCommand');
    assert.deepEqual(signed[0].input, { Bucket: 'bundles-bucket', Key: s3[0].input.Key });
    assert.deepEqual(signed[0].options, { expiresIn: 600 });

    // The private key goes to S3 and nowhere else.
    assert.ok(s3[0].input.Body.includes('not-a-real-key'));
    assert.ok(!res.body.includes('not-a-real-key'));
    assert.ok(!logs.some((line) => line.includes('not-a-real-key')));
    const [result] = resultsOf(res);
    assert.equal(result.ok, true);
    assert.equal(result.bundleUrl, 'https://bundles-bucket.s3.amazonaws.com/signed/1');
  });

  test(`${name}: a request that runs out of time sends the devices it did not reach back`, async (t) => {
    captureConsole(t);
    const { handler, iot } = load(t, name);
    const res = await handler(apiRequest({ devices: devices(3) }), { getRemainingTimeInMillis: () => 3000 });
    assert.equal(res.statusCode, 207);
    assert.ok(resultsOf(res).every((r) => r.ok === false && r.retryable === true));
    assert.equal(iot.length, 0);
  });
}

test('device-provisioning: ten devices in one request, one result each', async (t) => {
  captureConsole(t);
  const { handler, callsOf } = load(t, 'device-provisioning');
  const batch = devices(10);
  batch[0].thingGroup = 'canary-patient-monitor';

  const res = await handler(apiRequest({ devices: batch, ttlMinutes: 15 }));

  assert.equal(res.statusCode, 200);
  const results = resultsOf(res);
  assert.deepEqual(results.map((r) => r.thingName), batch.map((d) => d.thingName));
  assert.ok(results.every((r) => r.ok && r.thingArn && r.certificateId && r.bundleUrl));
  // The policy is the template's, by name from the environment.
  assert.ok(callsOf('AttachPolicyCommand').every((c) => c.input.policyName === POLICY));
  // A group named on the device wins; the rest get the configured default.
  const groups = callsOf('AddThingToThingGroupCommand').map((c) => [c.input.thingName, c.input.thingGroupName]);
  assert.deepEqual(groups.find(([thing]) => thing === 'pm-1'), ['pm-1', 'canary-patient-monitor']);
  assert.deepEqual(groups.find(([thing]) => thing === 'pm-2'), ['pm-2', 'fleet-patient-monitor']);
  // The data endpoint never changes: asked once, not once per device.
  assert.equal(callsOf('DescribeEndpointCommand').length, 1);
});

test('device-provisioning: a throttled device comes back retryable; the rest are provisioned', async (t) => {
  captureConsole(t);
  const { handler } = load(t, 'device-provisioning', {
    fail: (command, input) => {
      if (command === 'CreateThingCommand' && input.thingName === 'pm-3') throw awsError('ThrottlingException', 'Rate exceeded');
    },
  });

  const res = await handler(apiRequest({ devices: devices(5) }));

  assert.equal(res.statusCode, 207);
  const results = resultsOf(res);
  assert.deepEqual(results.find((r) => r.thingName === 'pm-3'), {
    thingName: 'pm-3', ok: false, retryable: true, error: 'Rate exceeded',
  });
  assert.equal(results.filter((r) => r.ok).length, 4);
});

test('device-provisioning: a failure after the certificate was made removes that certificate', async (t) => {
  captureConsole(t);
  const { handler, callsOf } = load(t, 'device-provisioning', {
    fail: (command) => {
      if (command === 'AddThingToThingGroupCommand') throw awsError('ResourceNotFoundException', 'Thing group fleet-x not found');
    },
  });

  const res = await handler(apiRequest({ devices: devices(1, { thingGroup: 'fleet-x' }) }));

  assert.deepEqual(resultsOf(res), [{ thingName: 'pm-1', ok: false, retryable: false, error: 'Thing group fleet-x not found' }]);
  // Left active, a retry would add a second working credential for the device.
  assert.deepEqual(callsOf('UpdateCertificateCommand').map((c) => c.input), [{ certificateId: 'new1', newStatus: 'INACTIVE' }]);
  assert.deepEqual(callsOf('DeleteCertificateCommand').map((c) => c.input), [{ certificateId: 'new1', forceDelete: true }]);
  // It never joined the group, so there is no membership to undo.
  assert.equal(callsOf('RemoveThingFromThingGroupCommand').length, 0);
});

// A failed attempt must leave an empty Thing in no group: that is the only
// kind of Thing device-teardown deletes when Salesforce deletes the device.
test('device-provisioning: a failure after the group step takes the Thing out of its group again', async (t) => {
  captureConsole(t);
  const { handler, iot, callsOf } = load(t, 'device-provisioning', {}, {
    failS3: (command) => {
      if (command === 'PutObjectCommand') throw awsError('AccessDenied', 'Access Denied');
    },
  });

  const res = await handler(apiRequest({ devices: devices(1) }));

  assert.deepEqual(resultsOf(res), [{ thingName: 'pm-1', ok: false, retryable: false, error: 'Access Denied' }]);
  assert.deepEqual(callsOf('RemoveThingFromThingGroupCommand').map((c) => c.input),
    [{ thingName: 'pm-1', thingGroupName: 'fleet-patient-monitor' }]);
  assert.deepEqual(callsOf('DeleteCertificateCommand').map((c) => c.input), [{ certificateId: 'new1', forceDelete: true }]);
  // Undone in reverse: out of the group first, then the certificate.
  const order = iot.map((c) => c.command);
  assert.ok(order.indexOf('RemoveThingFromThingGroupCommand') < order.indexOf('DetachThingPrincipalCommand'), order.join(', '));
});

test('device-provisioning: a failure leaves a Thing in a group it was in before', async (t) => {
  captureConsole(t);
  // For example a provisioned device between its old certificate and its new one.
  const { handler, callsOf } = load(t, 'device-provisioning', { groups: { 'pm-1': ['fleet-patient-monitor'] } }, {
    failS3: (command) => {
      if (command === 'PutObjectCommand') throw awsError('AccessDenied', 'Access Denied');
    },
  });

  const [result] = resultsOf(await handler(apiRequest({ devices: devices(1) })));

  assert.equal(result.ok, false);
  assert.equal(callsOf('RemoveThingFromThingGroupCommand').length, 0);
  assert.deepEqual(callsOf('DeleteCertificateCommand').map((c) => c.input), [{ certificateId: 'new1', forceDelete: true }]);
});

test('device-provisioning: a Thing that cannot leave its group still loses the certificate', async (t) => {
  const logs = captureConsole(t);
  const { handler, callsOf } = load(t, 'device-provisioning', {
    fail: (command) => {
      if (command === 'RemoveThingFromThingGroupCommand') throw awsError('ThrottlingException', 'Rate exceeded');
    },
  }, {
    failS3: (command) => {
      if (command === 'PutObjectCommand') throw awsError('AccessDenied', 'Access Denied');
    },
  });

  const [result] = resultsOf(await handler(apiRequest({ devices: devices(1) })));

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Access Denied');
  assert.deepEqual(callsOf('DeleteCertificateCommand').map((c) => c.input), [{ certificateId: 'new1', forceDelete: true }]);
  assert.ok(logs.some((line) => line.includes('remove it by hand') && line.includes('pm-1')), logs.join('\n'));
});

test('device-provisioning: a Thing that already has a certificate is not given a second one', async (t) => {
  captureConsole(t);
  const { handler, callsOf } = load(t, 'device-provisioning', { principals: { 'pm-1': [OLD_CERT_ARN] } });
  const [result] = resultsOf(await handler(apiRequest({ devices: devices(1) })));
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.match(result.error, /already has a certificate.*Re-provision/);
  // Re-provision refuses a device with no Thing ARN, so the answer names it.
  assert.match(result.error, /Thing ARN: arn:aws:iot:\S+:thing\/pm-1$/);
  assert.equal(callsOf('CreateKeysAndCertificateCommand').length, 0);
});

test('device-provisioning: the advice for a Thing that has a certificate fits in what Salesforce keeps', async (t) => {
  captureConsole(t);
  // Salesforce allows an 80-character serial number and keeps 255 characters of an error.
  const thingName = 'x'.repeat(80);
  const { handler } = load(t, 'device-provisioning', { principals: { [thingName]: [OLD_CERT_ARN] } });
  const [result] = resultsOf(await handler(apiRequest({ devices: [{ thingName, ssid: 'clinic' }] })));
  const kept = result.error.slice(0, 255);
  assert.match(kept, /set its Thing ARN .* use Re-provision; if not, use another serial number\./, kept);
});

test('device-provisioning: one device in the request body itself still works', async (t) => {
  captureConsole(t);
  const { handler } = load(t, 'device-provisioning');
  const res = await handler({ thingName: 'pm-1', ssid: 'clinic', passphrase: 'secret' });
  assert.equal(res.statusCode, 200);
  assert.equal(resultsOf(res)[0].expiresInMinutes, 15);   // DEFAULT_BUNDLE_TTL_MINUTES
});

test('device-provisioning requires a Thing name and an SSID', async (t) => {
  captureConsole(t);
  const { handler, iot } = load(t, 'device-provisioning');
  assert.equal((await handler({ thingName: 'pm-1' })).statusCode, 400);
  assert.equal((await handler(apiRequest({ devices: [] }))).statusCode, 400);
  assert.equal((await handler({ body: '{not json' })).statusCode, 400);
  // In a batch, the device that cannot be provisioned fails alone.
  const res = await handler(apiRequest({ devices: [{ thingName: 'pm/1', ssid: 'x' }, ...devices(1)] }));
  assert.equal(res.statusCode, 207);
  assert.deepEqual(resultsOf(res).map((r) => [r.ok, r.retryable]), [[false, false], [true, undefined]]);
  assert.ok(iot.every((c) => c.input.thingName !== 'pm/1'));
});

test('device-provisioning refuses a link lifetime a pre-signed URL cannot have', async (t) => {
  captureConsole(t);
  const { handler } = load(t, 'device-provisioning');
  for (const ttlMinutes of [0, -5, 'soon', 7 * 24 * 60 + 1]) {
    assert.equal((await handler(apiRequest({ devices: devices(1), ttlMinutes }))).statusCode, 400, String(ttlMinutes));
  }
});

test('device-reprovision revokes the old certificate by its id, with every policy it had', async (t) => {
  captureConsole(t);
  const { handler, callsOf } = load(t, 'device-reprovision', { principals: { 'pm-1': [OLD_CERT_ARN] } });

  const res = await handler(apiRequest({ devices: [{ thingName: 'pm-1' }] }));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(callsOf('DetachPolicyCommand').map((c) => c.input), [{ policyName: 'ESP32-Patient-Monitor-Policy', target: OLD_CERT_ARN }]);
  assert.deepEqual(callsOf('UpdateCertificateCommand').map((c) => c.input), [{ certificateId: 'old123', newStatus: 'INACTIVE' }]);
  assert.deepEqual(callsOf('DeleteCertificateCommand').map((c) => c.input), [{ certificateId: 'old123', forceDelete: true }]);
  // The new certificate gets the template's policy.
  assert.deepEqual(callsOf('AttachPolicyCommand').map((c) => c.input.policyName), [POLICY]);
  const [result] = resultsOf(res);
  assert.equal(result.revokedCount, 1);
  assert.equal(JSON.parse(res.body).historyPreserved, true);
});

test('device-reprovision: a Thing that does not exist fails without a retry', async (t) => {
  captureConsole(t);
  const { handler } = load(t, 'device-reprovision', {
    fail: (command) => {
      if (command === 'ListThingPrincipalsCommand') throw awsError('ResourceNotFoundException', 'Thing pm-1 not found');
    },
  });
  const [result] = resultsOf(await handler(apiRequest({ devices: [{ thingName: 'pm-1' }] })));
  assert.deepEqual(result, { thingName: 'pm-1', ok: false, retryable: false, error: 'Thing pm-1 not found' });
});
