'use strict';

const iotSdk = require('@aws-sdk/client-iot');
const {
  BadRequest, parseBody, respond, batchResponse, mapLimit, isTransient, isThingName, deadline,
} = require('@cloud-agentic-iot/shared/api');
const { retireCertificate, stillDetaching } = require('@cloud-agentic-iot/shared/certificates');
const { numberEnv } = require('@cloud-agentic-iot/shared/env');

const {
  IoTClient, ListThingPrincipalsCommand, ListThingGroupsForThingCommand, DeleteThingCommand,
} = iotSdk;

const iot = new IoTClient({ retryMode: 'adaptive' });   // see device-provisioning

const TIME_TO_ANSWER_MS = 4000;

/**
 * Tears down devices' AWS IoT footprint so their names can be reused.
 *
 *   { thingNames: [...], leftoverThingNames: [...] }
 *     -> 200 or 207 { results: [{ thingName, deleted, kept, retryable, error }] }
 *
 * thingNames are devices that were provisioned: their certificates go, then
 * the Thing. leftoverThingNames are deleted devices that never got that far,
 * because provisioning failed or had not finished, so they may have left a
 * Thing named after their serial number. That Thing is deleted only while it
 * has no certificate and is in no Thing Group, which is what a failed attempt
 * leaves: provisioning adds a Thing to its group only after attaching its
 * certificate. Any other Thing of that name is kept and reported as kept. It
 * may be another device's with the same serial number, one whose certificate
 * is being replaced right now, or this device's own identity that Salesforce
 * never recorded. A function from before leftoverThingNames answers such a
 * request with a 400 instead of tearing those Things down in full.
 *
 * The blocker this removes: a Thing that keeps its certificate blocks its
 * name. Provisioning refuses to give one Thing a second credential, and AWS
 * refuses to delete a Thing that still has principals attached. So a
 * Salesforce record deleted without cleanup leaves an orphan that blocks
 * ever re-registering that serial number.
 *
 * Order is not optional. A certificate cannot be deleted while it is attached
 * or ACTIVE, and a Thing cannot be deleted while any principal remains:
 *   detach policies -> detach principal -> deactivate -> delete cert -> delete thing
 * AWS completes a detach asynchronously, so a delete straight after it can be
 * refused while it settles. That comes back as retryable, and Salesforce
 * sends the Thing again a minute later (Retry_Delay_Minutes__c).
 *
 * Telemetry history is deliberately NOT deleted. DynamoDB rows, the S3
 * archive and Patient_Vitals__c records are keyed on the device name and are
 * usually required for audit long after the hardware is retired. Destroying
 * clinical history as a side effect of deleting a CRM record would be the
 * wrong default.
 */
exports.handler = async (event, context) => {
  let body;
  try {
    body = parseBody(event);
  } catch (err) {
    if (err instanceof BadRequest) return respond(400, { error: err.message });
    throw err;
  }
  const thingNames = Array.isArray(body.thingNames) ? body.thingNames : (body.thingName ? [body.thingName] : []);
  const leftoverThingNames = Array.isArray(body.leftoverThingNames) ? body.leftoverThingNames : [];
  if (!thingNames.length && !leftoverThingNames.length) {
    return respond(400, { error: 'thingNames or leftoverThingNames is required' });
  }
  const things = [
    ...thingNames.map((thingName) => ({ thingName, leftover: false })),
    ...leftoverThingNames.map((thingName) => ({ thingName, leftover: true })),
  ];

  const late = deadline(context, TIME_TO_ANSWER_MS);
  const results = await mapLimit(things, numberEnv('IOT_PARALLEL_REQUESTS'), ({ thingName, leftover }) => (late.passed()
    ? { thingName, deleted: false, retryable: true, error: 'Not reached before the request ran out of time; send it again.' }
    : tearDown(thingName, leftover)));
  return batchResponse(results, (result) => result.deleted || result.kept, { historyPreserved: true });
};

async function tearDown(thingName, leftover) {
  // A serial number AWS would not take as a Thing name never became a Thing.
  if (leftover && !isThingName(thingName)) {
    return { thingName, deleted: true, certificatesDeleted: 0 };
  }
  try {
    const { principals = [] } = await iot.send(new ListThingPrincipalsCommand({ thingName }));
    const reason = leftover ? await reasonToKeep(thingName, principals) : null;
    if (reason) {
      console.log('kept', { thingName, reason });
      return { thingName, deleted: false, kept: true, reason };
    }
    for (const principal of principals) {
      await retireCertificate(iot, iotSdk, thingName, principal);
    }
    // Thing Group membership disappears with the Thing; no explicit removal.
    await iot.send(new DeleteThingCommand({ thingName }));

    console.log('torn down', { thingName, certificatesDeleted: principals.length });
    return { thingName, deleted: true, certificatesDeleted: principals.length };
  } catch (err) {
    // ResourceNotFound means someone already cleaned it up. That is the
    // desired end state, so it is reported as success rather than failure.
    if (err.name === 'ResourceNotFoundException') {
      return { thingName, deleted: true, certificatesDeleted: 0 };
    }
    console.error('teardown failed', { thingName, error: err.message, name: err.name });
    return { thingName, deleted: false, retryable: isTransient(err) || stillDetaching(err), error: err.message };
  }
}

/**
 * Why a leftover Thing must stay, or null when it is what a failed
 * provisioning leaves: no certificate, and no Thing Group. A Thing in a group
 * had its certificate attached at least once, so it may be another device's,
 * or a provisioned one between its old certificate and its new one.
 */
async function reasonToKeep(thingName, principals) {
  if (principals.length) {
    return `${thingName} has a certificate, so it may be another device's. Delete it in AWS IoT if it is not.`;
  }
  const { thingGroups = [] } = await iot.send(new ListThingGroupsForThingCommand({ thingName, maxResults: 1 }));
  if (thingGroups.length) {
    return `${thingName} is in the Thing Group ${thingGroups[0].groupName}, so it may be another device's. `
      + 'Delete it in AWS IoT if it is not.';
  }
  return null;
}
