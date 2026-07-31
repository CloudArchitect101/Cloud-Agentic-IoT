const { IoTClient, ListThingPrincipalsCommand, DetachPolicyCommand,
        DetachThingPrincipalCommand, UpdateCertificateCommand, DeleteCertificateCommand,
        DeleteThingCommand } = require('@aws-sdk/client-iot');

const iot = new IoTClient({});
const POLICY_NAME = process.env.IOT_POLICY_NAME || 'ESP32-Patient-Monitor-Policy';

/**
 * Tears down a device's AWS IoT footprint so its name can be reused.
 *
 * The blocker this removes: AWS refuses to create a Thing whose name already
 * exists, and refuses to delete a Thing that still has principals attached.
 * So a Salesforce record deleted without cleanup leaves an orphan that blocks
 * ever re-registering that serial number.
 *
 * Order is not optional. A certificate cannot be deleted while it is attached
 * or ACTIVE, and a Thing cannot be deleted while any principal remains:
 *   detach policy -> detach principal -> deactivate -> delete cert -> delete thing
 *
 * Telemetry history is deliberately NOT deleted. DynamoDB rows and
 * Patient_Vitals__c records are keyed on the device name and are usually
 * required for audit long after the hardware is retired. Destroying clinical
 * history as a side effect of deleting a CRM record would be the wrong default.
 */
exports.handler = async (event) => {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : event;
  const thingNames = body.thingNames || (body.thingName ? [body.thingName] : []);

  if (!thingNames.length) {
    return respond(400, { error: 'thingNames is required' });
  }

  const results = [];
  for (const thingName of thingNames) {
    try {
      const { principals = [] } = await iot.send(new ListThingPrincipalsCommand({ thingName }));

      for (const principal of principals) {
        const certificateId = principal.split('/').pop;
        // Detaching a policy that is not attached is not an error worth
        // failing the teardown over - the goal is that it ends up detached.
        await iot.send(new DetachPolicyCommand({ policyName: POLICY_NAME, target: principal }))
          .catch((e) => console.warn('detach policy', thingName, e.message));
        await iot.send(new DetachThingPrincipalCommand({ thingName, principal }));
        await iot.send(new UpdateCertificateCommand({ certificateId, newStatus: 'INACTIVE' }));
        await iot.send(new DeleteCertificateCommand({ certificateId, forceDelete: true }));
      }

      // Thing Group membership disappears with the Thing; no explicit removal.
      await iot.send(new DeleteThingCommand({ thingName }));

      console.log('torn down', { thingName, certificatesDeleted: principals.length });
      results.push({ thingName, deleted: true, certificatesDeleted: principals.length });
    } catch (err) {
      // ResourceNotFound means someone already cleaned it up. That is the
      // desired end state, so report it as success rather than failure.
      const alreadyGone = err.name === 'ResourceNotFoundException';
      if (!alreadyGone) {
        console.error('teardown failed', { thingName, error: err.message });
      }
      results.push({ thingName, deleted: alreadyGone, error: alreadyGone ? null : err.message });
    }
  }

  const failures = results.filter((r) => !r.deleted);
  return respond(failures.length ? 207 : 200, { results, historyPreserved: true });
};

function respond(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
