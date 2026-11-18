'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadWithFakes, fakeAwsSdk, awsError, captureConsole } = require('../helpers/fakes');

const HANDLER = path.join(__dirname, '../../lambda/device-teardown/index.js');
const COMMANDS = [
  'ListThingPrincipalsCommand', 'DetachPolicyCommand', 'DetachThingPrincipalCommand',
  'UpdateCertificateCommand', 'DeleteCertificateCommand', 'DeleteThingCommand',
];
const CERT_ARN = 'arn:aws:iot:ca-central-1:111122223333:cert/abc123';

function load(respond) {
  const iot = fakeAwsSdk('IoTClient', COMMANDS, respond);
  const { handler } = loadWithFakes(HANDLER, { '@aws-sdk/client-iot': iot.sdk });
  return { handler, calls: iot.calls };
}

const listsOneCertificate = (command) =>
  (command === 'ListThingPrincipalsCommand' ? { principals: [CERT_ARN] } : {});

test('tears down in order, passing the certificate id as a string', async (t) => {
  captureConsole(t);
  const { handler, calls } = load(listsOneCertificate);

  const res = await handler({ thingName: 'pm-1' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.map((c) => c.command), COMMANDS);
  // Used to be the Array.prototype.pop function itself, so the certificate
  // was never deactivated or deleted.
  const update = calls.find((c) => c.command === 'UpdateCertificateCommand');
  const remove = calls.find((c) => c.command === 'DeleteCertificateCommand');
  assert.deepEqual(update.input, { certificateId: 'abc123', newStatus: 'INACTIVE' });
  assert.deepEqual(remove.input, { certificateId: 'abc123', forceDelete: true });
  assert.deepEqual(JSON.parse(res.body).results, [{ thingName: 'pm-1', deleted: true, certificatesDeleted: 1 }]);
});

test('a Thing that is already gone counts as torn down', async (t) => {
  captureConsole(t);
  const { handler } = load(() => { throw awsError('ResourceNotFoundException'); });
  const res = await handler({ thingNames: ['pm-1'] });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).results[0].deleted, true);
});

test('any other failure is reported per Thing with a 207', async (t) => {
  captureConsole(t);
  const { handler } = load((command) => {
    if (command === 'DeleteThingCommand') throw awsError('InvalidRequestException', 'principals still attached');
    return listsOneCertificate(command);
  });
  const res = await handler({ body: JSON.stringify({ thingNames: ['pm-1'] }) });
  assert.equal(res.statusCode, 207);
  assert.deepEqual(JSON.parse(res.body).results[0], {
    thingName: 'pm-1', deleted: false, error: 'principals still attached',
  });
});

test('requires at least one Thing name', async (t) => {
  captureConsole(t);
  const { handler, calls } = load();
  const res = await handler({});
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});
