'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadWithFakes, fakeAwsSdk, awsError, captureConsole, withEnv } = require('../helpers/fakes');

const HANDLER = path.join(__dirname, '../../lambda/device-teardown/index.js');
const COMMANDS = [
  'ListThingPrincipalsCommand', 'ListAttachedPoliciesCommand', 'DetachPolicyCommand', 'DetachThingPrincipalCommand',
  'UpdateCertificateCommand', 'DeleteCertificateCommand', 'DeleteThingCommand',
];
// Asked only for a leftover, so not part of the full teardown's order above.
const LEFTOVER_COMMANDS = [...COMMANDS, 'ListThingGroupsForThingCommand'];
const CERT_ARN = 'arn:aws:iot:ca-central-1:111122223333:cert/abc123';

function load(t, respond) {
  withEnv(t, { IOT_PARALLEL_REQUESTS: '4' });
  const iot = fakeAwsSdk('IoTClient', LEFTOVER_COMMANDS, respond);
  const { handler } = loadWithFakes(HANDLER, { '@aws-sdk/client-iot': iot.sdk });
  return { handler, calls: iot.calls };
}

const listsOneCertificate = (command) => {
  if (command === 'ListThingPrincipalsCommand') return { principals: [CERT_ARN] };
  if (command === 'ListAttachedPoliciesCommand') return { policies: [{ policyName: 'cloud-agentic-iot-device' }] };
  return {};
};

test('tears down in order, passing the certificate id as a string', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t, listsOneCertificate);

  const res = await handler({ thingName: 'pm-1' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.map((c) => c.command), COMMANDS);
  // Used to be the Array.prototype.pop function itself, so the certificate
  // was never deactivated or deleted.
  const update = calls.find((c) => c.command === 'UpdateCertificateCommand');
  const remove = calls.find((c) => c.command === 'DeleteCertificateCommand');
  assert.deepEqual(update.input, { certificateId: 'abc123', newStatus: 'INACTIVE' });
  assert.deepEqual(remove.input, { certificateId: 'abc123', forceDelete: true });
  // Every policy on the certificate is detached, by the name AWS reports.
  assert.deepEqual(calls.find((c) => c.command === 'DetachPolicyCommand').input, {
    policyName: 'cloud-agentic-iot-device', target: CERT_ARN,
  });
  assert.deepEqual(JSON.parse(res.body).results, [{ thingName: 'pm-1', deleted: true, certificatesDeleted: 1 }]);
});

test('a batch of Things gets one result each, in order', async (t) => {
  captureConsole(t);
  const { handler } = load(t, listsOneCertificate);
  const thingNames = Array.from({ length: 25 }, (_, i) => `pm-${i}`);
  const res = await handler({ body: JSON.stringify({ thingNames }) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).results.map((r) => r.thingName), thingNames);
});

test('a Thing that is already gone counts as torn down', async (t) => {
  captureConsole(t);
  const { handler } = load(t, () => { throw awsError('ResourceNotFoundException'); });
  const res = await handler({ thingNames: ['pm-1'] });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).results[0].deleted, true);
});

test('a delete AWS refuses while a detach settles comes back retryable', async (t) => {
  captureConsole(t);
  const { handler } = load(t, (command) => {
    if (command === 'DeleteThingCommand') throw awsError('InvalidRequestException', 'principals still attached');
    return listsOneCertificate(command);
  });
  const res = await handler({ body: JSON.stringify({ thingNames: ['pm-1'] }) });
  assert.equal(res.statusCode, 207);
  assert.deepEqual(JSON.parse(res.body).results[0], {
    thingName: 'pm-1', deleted: false, retryable: true, error: 'principals still attached',
  });
});

test('any other failure is reported per Thing with a 207, not retryable', async (t) => {
  captureConsole(t);
  const { handler } = load(t, (command, input) => {
    if (command === 'ListThingPrincipalsCommand' && input.thingName === 'pm-2') {
      throw awsError('UnauthorizedException', 'not allowed');
    }
    return listsOneCertificate(command);
  });
  const res = await handler({ thingNames: ['pm-1', 'pm-2'] });
  assert.equal(res.statusCode, 207);
  assert.deepEqual(JSON.parse(res.body).results.map((r) => [r.thingName, r.deleted, r.retryable]), [
    ['pm-1', true, undefined], ['pm-2', false, false],
  ]);
});

test('requires at least one Thing name', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t);
  const res = await handler({});
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

// A deleted device whose provisioning failed, or had not finished, comes as a
// leftover: Salesforce never recorded a Thing for it, so the Thing named after
// its serial number is either what that attempt left, or not this device's.
test('a leftover Thing with no certificate and no Thing Group is deleted', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t, (command) => (command === 'ListThingPrincipalsCommand' ? { principals: [] } : {}));
  const res = await handler({ body: JSON.stringify({ leftoverThingNames: ['1Test1'] }) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.map((c) => [c.command, c.input.thingName]), [
    ['ListThingPrincipalsCommand', '1Test1'], ['ListThingGroupsForThingCommand', '1Test1'], ['DeleteThingCommand', '1Test1'],
  ]);
  assert.deepEqual(JSON.parse(res.body).results, [{ thingName: '1Test1', deleted: true, certificatesDeleted: 0 }]);
});

// Provisioning adds a Thing to its group only after attaching its
// certificate, so a Thing in a group with none may be a provisioned device's
// whose certificate is being replaced, not a failed attempt's.
test('a leftover Thing in a Thing Group is kept, even with no certificate', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t, (command) => {
    if (command === 'ListThingPrincipalsCommand') return { principals: [] };
    if (command === 'ListThingGroupsForThingCommand') return { thingGroups: [{ groupName: 'fleet-patient-monitor' }] };
    return {};
  });
  const res = await handler({ body: JSON.stringify({ leftoverThingNames: ['pm-1'] }) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.map((c) => c.command), ['ListThingPrincipalsCommand', 'ListThingGroupsForThingCommand']);
  const [result] = JSON.parse(res.body).results;
  assert.equal(result.kept, true);
  assert.equal(result.deleted, false);
  assert.match(result.reason, /pm-1 is in the Thing Group fleet-patient-monitor/);
});

test('a leftover Thing that has a certificate is kept, certificate and all', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t, listsOneCertificate);
  const res = await handler({ body: JSON.stringify({ leftoverThingNames: ['pm-1'] }) });
  // Kept is the answer asked for, not a failure: nothing is retried.
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.map((c) => c.command), ['ListThingPrincipalsCommand']);
  const [result] = JSON.parse(res.body).results;
  assert.equal(result.deleted, false);
  assert.equal(result.kept, true);
  assert.match(result.reason, /pm-1 has a certificate/);
});

test('provisioned and leftover Things in one request each get their own teardown', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t, listsOneCertificate);
  const res = await handler({ body: JSON.stringify({ thingNames: ['pm-1'], leftoverThingNames: ['pm-2'] }) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).results.map((r) => [r.thingName, r.deleted, r.kept]), [
    ['pm-1', true, undefined], ['pm-2', false, true],
  ]);
  // Only pm-1's certificate is retired.
  assert.equal(calls.filter((c) => c.command === 'DeleteCertificateCommand').length, 1);
  assert.deepEqual(calls.filter((c) => c.command === 'DeleteThingCommand').map((c) => c.input.thingName), ['pm-1']);
});

test('a leftover serial number AWS would not take as a Thing name was never a Thing', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(t);
  const res = await handler({ leftoverThingNames: ['SN 42/7'] });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(res.body).results[0].deleted, true);
});
