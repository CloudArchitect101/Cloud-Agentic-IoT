'use strict';

const iotSdk = require('@aws-sdk/client-iot');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const {
  BadRequest, parseBody, respond, batchResponse, mapLimit, isTransient, isThingName, deadline,
} = require('@cloud-agentic-iot/shared/api');
const { retireCertificate, discardCertificate, stillDetaching } = require('@cloud-agentic-iot/shared/certificates');
const { requiredEnv, numberEnv } = require('@cloud-agentic-iot/shared/env');

const {
  IoTClient, ListThingPrincipalsCommand, CreateKeysAndCertificateCommand, AttachPolicyCommand,
  AttachThingPrincipalCommand, DescribeEndpointCommand,
} = iotSdk;

const iot = new IoTClient({ retryMode: 'adaptive' });   // see device-provisioning
const s3 = new S3Client({});

const TIME_TO_ANSWER_MS = 4000;
const MAX_TTL_MINUTES = 7 * 24 * 60;

let endpoint = null;   // a promise, asked once per container - see device-provisioning

/**
 * Rotates devices' certificates WITHOUT deleting their Things.
 *
 *   { devices: [{ thingName, ssid, passphrase }], ttlMinutes }
 *     -> 200 or 207 { results: [{ thingName, ok, retryable, error,
 *                                 certificateId, revokedCount, bundleUrl }] }
 *
 * This is the recovery path when NVS was erased and the private key is gone:
 * AWS issues it once, so it cannot be recovered, only replaced.
 *
 * The Thing is deliberately preserved. The Thing name is the device's
 * identity; the certificate is only how it proves that identity. Deleting and
 * recreating the Thing would discard Thing Group membership (so OTA would stop
 * targeting it), its shadow, and its attributes, and would orphan every row of
 * history keyed on that name in DynamoDB, S3, Salesforce and Data Cloud.
 * Rotating the certificate is the equivalent of changing a password: the
 * account, and everything it ever did, is untouched.
 */
exports.handler = async (event, context) => {
  let body;
  try {
    body = parseBody(event);
  } catch (err) {
    if (err instanceof BadRequest) return respond(400, { error: err.message });
    throw err;
  }
  const devices = Array.isArray(body.devices) ? body.devices : (body.thingName ? [body] : []);
  if (!devices.length) {
    return respond(400, { error: 'devices is required: [{ thingName, ssid, passphrase }]' });
  }
  const ttlMinutes = body.ttlMinutes === undefined ? numberEnv('DEFAULT_BUNDLE_TTL_MINUTES') : Number(body.ttlMinutes);
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > MAX_TTL_MINUTES) {
    return respond(400, { error: `ttlMinutes must be between 1 and ${MAX_TTL_MINUTES}` });
  }

  const settings = { policyName: requiredEnv('IOT_POLICY_NAME'), bucket: requiredEnv('BUNDLE_BUCKET'), ttlMinutes };
  const late = deadline(context, TIME_TO_ANSWER_MS);
  const results = await mapLimit(devices, numberEnv('IOT_PARALLEL_REQUESTS'), (device) => (late.passed()
    ? { thingName: device && device.thingName, ok: false, retryable: true, error: 'Not reached before the request ran out of time; send it again.' }
    : rotate(device, settings)));
  return batchResponse(results, (result) => result.ok, { historyPreserved: true });
};

async function rotate(device, { policyName, bucket, ttlMinutes }) {
  const { thingName, ssid, passphrase } = device || {};
  if (!isThingName(thingName)) {
    return { thingName, ok: false, retryable: false, error: 'thingName must be an AWS IoT Thing name.' };
  }

  let cert = null;
  try {
    // Revoke every certificate currently attached, first. Leaving the old one
    // active would mean a device with a copied key could still connect: the
    // whole point of rotating is that the previous credential stops working.
    const { principals = [] } = await iot.send(new ListThingPrincipalsCommand({ thingName }));
    for (const principal of principals) {
      const certificateId = await retireCertificate(iot, iotSdk, thingName, principal);
      console.log('revoked certificate', { thingName, certificateId });
    }

    cert = await iot.send(new CreateKeysAndCertificateCommand({ setAsActive: true }));
    await iot.send(new AttachPolicyCommand({ policyName, target: cert.certificateArn }));
    await iot.send(new AttachThingPrincipalCommand({ thingName, principal: cert.certificateArn }));

    if (!endpoint) {
      endpoint = iot.send(new DescribeEndpointCommand({ endpointType: 'iot:Data-ATS' }))
        .then((result) => result.endpointAddress)
        .catch((err) => {
          endpoint = null;
          throw err;
        });
    }
    const dataEndpoint = await endpoint;
    const key = `provisioning/${thingName}-rotated-${Date.now()}.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify({
        thingName,
        endpoint: dataEndpoint,
        ssid: ssid || '',
        passphrase: passphrase || '',
        certificatePem: cert.certificatePem,
        privateKey: cert.keyPair.PrivateKey,
      }, null, 2),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }));
    // Signed for GetObject, the download - see device-provisioning.
    const bundleUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttlMinutes * 60 });

    return {
      thingName,
      ok: true,
      certificateId: cert.certificateId,
      revokedCount: principals.length,
      bundleUrl,
      expiresInMinutes: ttlMinutes,
    };
  } catch (err) {
    if (cert) await discardCertificate(iot, iotSdk, thingName, cert.certificateArn);
    console.error('reprovision failed', { thingName, error: err.message, name: err.name });
    // A Thing that does not exist was never provisioned: retrying cannot help.
    return { thingName, ok: false, retryable: isTransient(err) || stillDetaching(err), error: err.message };
  }
}
