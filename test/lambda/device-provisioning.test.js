'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadWithFakes, fakeAwsSdk, captureConsole, withEnv } = require('../helpers/fakes');

const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----';
const OLD_CERT_ARN = 'arn:aws:iot:ca-central-1:111122223333:cert/old123';

const IOT_COMMANDS = [
  'CreateThingCommand', 'CreateKeysAndCertificateCommand', 'AttachPolicyCommand',
  'AttachThingPrincipalCommand', 'AddThingToThingGroupCommand', 'DescribeEndpointCommand',
  'ListThingPrincipalsCommand', 'DetachPolicyCommand', 'DetachThingPrincipalCommand',
  'UpdateCertificateCommand', 'DeleteCertificateCommand',
];

function iotResponses(command) {
  switch (command) {
    case 'CreateThingCommand':
      return { thingArn: 'arn:aws:iot:ca-central-1:111122223333:thing/pm-1' };
    case 'CreateKeysAndCertificateCommand':
      return {
        certificateArn: 'arn:aws:iot:ca-central-1:111122223333:cert/new456',
        certificateId: 'new456',
        certificatePem: '-----BEGIN CERTIFICATE-----\nnew\n-----END CERTIFICATE-----',
        keyPair: { PrivateKey: PRIVATE_KEY },
      };
    case 'DescribeEndpointCommand':
      return { endpointAddress: 'example-ats.iot.ca-central-1.amazonaws.com' };
    case 'ListThingPrincipalsCommand':
      return { principals: [OLD_CERT_ARN] };
    default:
      return {};
  }
}

function load(t, name) {
  withEnv(t, { BUNDLE_BUCKET: 'bundles-bucket' });
  const iot = fakeAwsSdk('IoTClient', IOT_COMMANDS, iotResponses);
  const s3 = fakeAwsSdk('S3Client', ['PutObjectCommand', 'GetObjectCommand']);
  const signed = [];
  const presigner = {
    getSignedUrl: async (client, command, options) => {
      signed.push({ command: command.constructor.name, input: command.input, options });
      return 'https://bundles-bucket.s3.amazonaws.com/signed';
    },
  };
  const { handler } = loadWithFakes(path.join(__dirname, `../../lambda/${name}/index.js`), {
    '@aws-sdk/client-iot': iot.sdk,
    '@aws-sdk/client-s3': s3.sdk,
    '@aws-sdk/s3-request-presigner': presigner,
  });
  return { handler, iot: iot.calls, s3: s3.calls, signed };
}

for (const name of ['device-provisioning', 'device-reprovision']) {
  test(`${name}: the bundle link is signed for download, for the object just written`, async (t) => {
    const logs = captureConsole(t);
    const { handler, s3, signed } = load(t, name);

    const res = await handler({ thingName: 'pm-1', ssid: 'clinic', passphrase: 'secret', ttlMinutes: 10 });

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
    assert.equal(JSON.parse(res.body).bundleUrl, 'https://bundles-bucket.s3.amazonaws.com/signed');
  });
}

test('device-reprovision revokes the old certificate by its id', async (t) => {
  captureConsole(t);
  const { handler, iot } = load(t, 'device-reprovision');
  await handler({ thingName: 'pm-1' });

  const update = iot.find((c) => c.command === 'UpdateCertificateCommand');
  const remove = iot.find((c) => c.command === 'DeleteCertificateCommand');
  assert.deepEqual(update.input, { certificateId: 'old123', newStatus: 'INACTIVE' });
  assert.deepEqual(remove.input, { certificateId: 'old123', forceDelete: true });
});

test('device-provisioning requires a Thing name and an SSID', async (t) => {
  captureConsole(t);
  const { handler, iot } = load(t, 'device-provisioning');
  const res = await handler({ thingName: 'pm-1' });
  assert.equal(res.statusCode, 400);
  assert.equal(iot.length, 0);
});
