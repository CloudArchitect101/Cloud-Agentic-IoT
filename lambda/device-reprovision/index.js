const { IoTClient, ListThingPrincipalsCommand, DetachPolicyCommand,
        DetachThingPrincipalCommand, UpdateCertificateCommand, DeleteCertificateCommand,
        CreateKeysAndCertificateCommand, AttachPolicyCommand, AttachThingPrincipalCommand,
        DescribeEndpointCommand } = require('@aws-sdk/client-iot');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const iot = new IoTClient({});
const s3 = new S3Client({});
const POLICY_NAME = process.env.IOT_POLICY_NAME || 'ESP32-Patient-Monitor-Policy';
const BUNDLE_BUCKET = process.env.BUNDLE_BUCKET;

/**
 * Rotates a device's certificate WITHOUT deleting its Thing.
 *
 * This is the recovery path when NVS was erased and the private key is gone -
 * AWS issues it once, so it cannot be recovered, only replaced.
 *
 * The Thing is deliberately preserved. The Thing name is the device's
 * identity; the certificate is only how it proves that identity. Deleting and
 * recreating the Thing would discard Thing Group membership (so OTA would stop
 * targeting it), its shadow, and its attributes - and would orphan every row of
 * history keyed on that name in DynamoDB, Salesforce and Data Cloud.
 *
 * Rotating the certificate is the equivalent of changing a password: the
 * account, and everything it ever did, is untouched.
 */
exports.handler = async (event) => {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : event;
  const { thingName, ssid, passphrase, ttlMinutes = 15 } = body;

  if (!thingName) {
    return respond(400, { error: 'thingName is required' });
  }

  try {
    // Revoke every certificate currently attached. Leaving the old one active
    // would mean a device with a copied key could still connect - the whole
    // point of rotating is that the previous credential stops working.
    const { principals = [] } = await iot.send(new ListThingPrincipalsCommand({ thingName }));
    for (const principal of principals) {
      const certificateId = principal.split('/').pop();
      await iot.send(new DetachPolicyCommand({ policyName: POLICY_NAME, target: principal }))
        .catch((e) => console.warn('detach policy', e.message));
      await iot.send(new DetachThingPrincipalCommand({ thingName, principal }));
      await iot.send(new UpdateCertificateCommand({ certificateId, newStatus: 'INACTIVE' }));
      await iot.send(new DeleteCertificateCommand({ certificateId, forceDelete: true }));
      console.log('revoked certificate', { thingName, certificateId });
    }

    const cert = await iot.send(new CreateKeysAndCertificateCommand({ setAsActive: true }));
    await iot.send(new AttachPolicyCommand({ policyName: POLICY_NAME, target: cert.certificateArn }));
    await iot.send(new AttachThingPrincipalCommand({ thingName, principal: cert.certificateArn }));

    const { endpointAddress } = await iot.send(new DescribeEndpointCommand({
      endpointType: 'iot:Data-ATS',
    }));

    const bundle = {
      thingName,
      endpoint: endpointAddress,
      ssid: ssid || '',
      passphrase: passphrase || '',
      certificatePem: cert.certificatePem,
      privateKey: cert.keyPair.PrivateKey,
    };

    const key = `provisioning/${thingName}-rotated-${Date.now()}.json`;
    await s3.send(new PutObjectCommand({
      Bucket: BUNDLE_BUCKET,
      Key: key,
      Body: JSON.stringify(bundle, null, 2),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }));
    const bundleUrl = await getSignedUrl(
      s3, new PutObjectCommand({ Bucket: BUNDLE_BUCKET, Key: key }), { expiresIn: ttlMinutes * 60 }
    );

    return respond(200, {
      thingName,
      certificateId: cert.certificateId,
      revokedCount: principals.length,
      bundleUrl,
      expiresInMinutes: ttlMinutes,
      // Stated explicitly because it is the question everyone asks:
      historyPreserved: true,
    });
  } catch (err) {
    console.error('reprovision failed', { thingName, error: err.message });
    return respond(500, { error: err.message });
  }
};

function respond(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
