const crypto = require('crypto');
const { getSalesforceConnection } = require('./salesforce-client');

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

/**
 * Verifies the request actually came from Slack (HMAC over the raw body +
 * timestamp) and rejects anything older than 5 minutes to prevent replay.
 * This is the only "identity" check in the whole flow — there is no
 * Salesforce login involved anywhere in this request path.
 */
function verifySlackSignature(event) {
  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const timestamp = headers['x-slack-request-timestamp'];
  const signature = headers['x-slack-signature'];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;

  const baseString = `v0:${timestamp}:${event.body}`;
  const computed = `v0=${crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(baseString).digest('hex')}`;

  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}

function slackResponse(text) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', text }),
  };
}

exports.handler = async (event) => {
  if (!verifySlackSignature(event)) {
    return { statusCode: 401, body: 'Invalid Slack signature' };
  }

  const params = new URLSearchParams(event.body);
  const command = params.get('command');
  const deviceId = (params.get('text') || '').trim();

  const conn = await getSalesforceConnection();

  if (command === '/patient-status') {
    const rows = await conn
      .sobject('Patient_Vitals__c')
      .find({ Device__c: deviceId }, 'Temperature__c,Humidity__c,CreatedDate')
      .sort({ CreatedDate: -1 })
      .limit(1)
      .execute();

    if (!rows.length) {
      return slackResponse(`No vitals found for device \`${deviceId}\`.`);
    }

    const v = rows[0];
    return slackResponse(
      `*Device ${deviceId}* — ${v.Temperature__c}°C, ${v.Humidity__c}% humidity (as of ${v.CreatedDate})`
    );
  }

  if (command === '/dispense-medication') {
    // Headless write-back: this creates a command record. A Salesforce
    // Flow/Apex trigger on Device_Command__c publishes a Platform Event
    // that the 00-iot-device-provisioning branch's ESP32 device is already
    // listening for via AWS IoT Core — closing the loop from Slack all the
    // way to the physical servo motor.
    await conn.sobject('Device_Command__c').create({
      Device__c: deviceId,
      Command__c: 'DISPENSE_MEDICATION',
      Requested_By__c: 'Slack',
      Status__c: 'Pending',
    });

    return slackResponse(
      `Dispense command queued for device \`${deviceId}\`. No Salesforce login required — this ran under a dedicated integration user via JWT Bearer Flow.`
    );
  }

  return slackResponse(`Unknown command: ${command}`);
};
