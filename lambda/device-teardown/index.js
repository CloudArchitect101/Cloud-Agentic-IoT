'use strict';

const iotSdk = require('@aws-sdk/client-iot');
const {
  BadRequest, parseBody, respond, batchResponse, mapLimit, isTransient, deadline,
} = require('@cloud-agentic-iot/shared/api');
const { retireCertificate, stillDetaching } = require('@cloud-agentic-iot/shared/certificates');
const { numberEnv } = require('@cloud-agentic-iot/shared/env');

const { IoTClient, ListThingPrincipalsCommand, DeleteThingCommand } = iotSdk;

const iot = new IoTClient({ retryMode: 'adaptive' });   // see device-provisioning

const TIME_TO_ANSWER_MS = 4000;

/**
 * Tears down devices' AWS IoT footprint so their names can be reused.
 *
 *   { thingNames: [...] } -> 200 or 207 { results: [{ thingName, deleted, retryable, error }] }
 *
 * The blocker this removes: AWS refuses to create a Thing whose name already
 * exists, and refuses to delete a Thing that still has principals attached.
 * So a Salesforce record deleted without cleanup leaves an orphan that blocks
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
  if (!thingNames.length) {
    return respond(400, { error: 'thingNames is required' });
  }

  const late = deadline(context, TIME_TO_ANSWER_MS);
  const results = await mapLimit(thingNames, numberEnv('IOT_PARALLEL_REQUESTS'), (thingName) => (late.passed()
    ? { thingName, deleted: false, retryable: true, error: 'Not reached before the request ran out of time; send it again.' }
    : tearDown(thingName)));
  return batchResponse(results, (result) => result.deleted, { historyPreserved: true });
};

async function tearDown(thingName) {
  try {
    const { principals = [] } = await iot.send(new ListThingPrincipalsCommand({ thingName }));
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
