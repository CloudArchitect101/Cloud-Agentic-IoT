'use strict';

/*
 * Retiring device certificates, for provisioning (cleaning up after a
 * failure), re-provisioning and teardown.
 *
 * The functions pass in their own IoT client and the @aws-sdk/client-iot
 * module, so this package does not depend on the IoT SDK itself, and the
 * functions that never touch certificates do not ship it.
 */

/**
 * Detaches the certificate from every policy and from the Thing, deactivates
 * it, and deletes it. The order is AWS's: a certificate cannot be deleted
 * while it is ACTIVE or attached to a Thing. Every attached policy is
 * detached, not one named in configuration, so a certificate made under an
 * older policy name is retired just as cleanly.
 */
async function retireCertificate(iot, sdk, thingName, certificateArn) {
  const certificateId = certificateArn.split('/').pop();
  const { policies = [] } = await iot.send(new sdk.ListAttachedPoliciesCommand({ target: certificateArn }));
  for (const { policyName } of policies) {
    await iot.send(new sdk.DetachPolicyCommand({ policyName, target: certificateArn }));
  }
  await iot.send(new sdk.DetachThingPrincipalCommand({ thingName, principal: certificateArn }));
  await iot.send(new sdk.UpdateCertificateCommand({ certificateId, newStatus: 'INACTIVE' }));
  await iot.send(new sdk.DeleteCertificateCommand({ certificateId, forceDelete: true }));
  return certificateId;
}

/**
 * The same for a certificate this request made and could not finish setting
 * up, so no half-made credential is left active. Detach steps that fail are
 * skipped (it may not have been attached yet). Never throws: a certificate
 * that could not be removed is logged by id, for a person to remove.
 */
async function discardCertificate(iot, sdk, thingName, certificateArn) {
  const certificateId = certificateArn.split('/').pop();
  const quietly = (command) => iot.send(command).catch(() => ({}));
  try {
    const { policies = [] } = await quietly(new sdk.ListAttachedPoliciesCommand({ target: certificateArn }));
    for (const { policyName } of policies) {
      await quietly(new sdk.DetachPolicyCommand({ policyName, target: certificateArn }));
    }
    await quietly(new sdk.DetachThingPrincipalCommand({ thingName, principal: certificateArn }));
    await iot.send(new sdk.UpdateCertificateCommand({ certificateId, newStatus: 'INACTIVE' }));
    await iot.send(new sdk.DeleteCertificateCommand({ certificateId, forceDelete: true }));
  } catch (err) {
    console.error('Could not remove a certificate after a failed setup; remove it by hand', {
      thingName, certificateId, error: err.message,
    });
  }
}

/**
 * AWS detaches a principal from a Thing asynchronously, so deleting the
 * certificate or the Thing straight after can fail while the detach settles.
 * That is a "not yet", and the caller reports it as retryable.
 */
function stillDetaching(err) {
  return Boolean(err) && (err.name === 'DeleteConflictException'
    || (err.name === 'InvalidRequestException' && /attached/i.test(err.message || '')));
}

module.exports = { retireCertificate, discardCertificate, stillDetaching };
