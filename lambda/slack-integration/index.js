'use strict';

/*
 * Slack slash commands, answered from Salesforce as the integration user.
 *
 * Slack waits 3 seconds for an answer and then tells the person "the app did
 * not respond". Reading the signing secret, signing in to Salesforce with the
 * JWT Bearer Flow and running the query can take longer than that on a cold
 * start, so a command is handled in two halves by the same function:
 *
 *   1. From API Gateway: check Slack's signature, check the device name,
 *      start the second half asynchronously, and answer "Working on it" at
 *      once.
 *   2. Invoked asynchronously with { slackCommand }: do the Salesforce work
 *      and post the answer to the command's response_url, which Slack keeps
 *      open for 30 minutes.
 *
 * Slack never signs in to Salesforce: the signature check is the only
 * identity check on this path, and every Salesforce call runs as the one
 * integration user, as every other function here does.
 */

const crypto = require('node:crypto');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { getParameter } = require('@cloud-agentic-iot/shared/config');
const { requiredEnv } = require('@cloud-agentic-iot/shared/env');
const salesforce = require('@cloud-agentic-iot/shared/salesforce');

const lambda = new LambdaClient({});

// An AWS IoT Thing name, which is what a device is called everywhere here.
// Checked before it goes anywhere near SOQL.
const DEVICE_NAME = /^[A-Za-z0-9_:-]{1,100}$/;
const COMMANDS = new Set(['/patient-status', '/dispense-medication']);
const SLACK_HOOKS = /^https:\/\/hooks\.slack\.com\//;

/**
 * API Gateway HTTP APIs hand a form-encoded body over base64-encoded. Slack
 * signs the body it sent, so the signature is checked against the decoded
 * text.
 */
function rawBody(event) {
  const body = event.body || '';
  return event.isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
}

/**
 * Verifies the request came from Slack (HMAC over the timestamp and raw
 * body) and rejects anything older than 5 minutes, so it cannot be replayed.
 */
function verifySlackSignature(headers, body, signingSecret) {
  const lower = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const timestamp = lower['x-slack-request-timestamp'];
  const signature = lower['x-slack-signature'];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const computed = `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  // timingSafeEqual throws on buffers of different lengths.
  const expected = Buffer.from(computed);
  const received = Buffer.from(String(signature));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function slackResponse(text) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', text }),
  };
}

/** The first half: answer Slack within its 3 seconds. */
async function acknowledge(event) {
  const body = rawBody(event);
  const signingSecret = await getParameter(requiredEnv('SLACK_SIGNING_SECRET_PARAMETER'), { decrypt: true });
  if (!verifySlackSignature(event.headers, body, signingSecret)) {
    console.warn('refused: the Slack signature did not match');
    return { statusCode: 401, body: 'Invalid Slack signature' };
  }

  const params = new URLSearchParams(body);
  const command = params.get('command');
  const deviceId = (params.get('text') || '').trim();
  const responseUrl = params.get('response_url') || '';

  if (!COMMANDS.has(command)) return slackResponse(`Unknown command: ${command}`);
  if (!DEVICE_NAME.test(deviceId)) {
    return slackResponse(`Name one device, for example \`${command} Test8\`.`);
  }
  if (!SLACK_HOOKS.test(responseUrl)) {
    console.warn('refused: no Slack response_url', { command });
    return slackResponse('Slack sent no address to answer on; try again.');
  }

  await lambda.send(new InvokeCommand({
    FunctionName: requiredEnv('AWS_LAMBDA_FUNCTION_NAME'),
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ slackCommand: { command, deviceId, responseUrl } })),
  }));
  console.log('accepted', { command, deviceId });
  return slackResponse(command === '/patient-status'
    ? `Looking up \`${deviceId}\`…`
    : `Sending a dose request to \`${deviceId}\`…`);
}

async function patientStatus(deviceId) {
  const rows = await salesforce.query(
    'SELECT Temperature__c, Humidity__c, CreatedDate FROM Patient_Vitals__c '
    + `WHERE Device__c = '${deviceId}' ORDER BY CreatedDate DESC LIMIT 1`,
  );
  if (!rows.length) return `No vitals found for device \`${deviceId}\`.`;
  const v = rows[0];
  return `*Device ${deviceId}*: ${v.Temperature__c}°C, ${v.Humidity__c}% humidity (as of ${v.CreatedDate})`;
}

async function dispenseMedication(deviceId) {
  // A Pending Device Command, as Send Command on the Asset makes:
  // DeviceCommandTrigger sends it to the board through the device-command
  // function and the guardrails, and the board's ack moves it to Acked or
  // Failed. So the answer says the command was queued, not carried out.
  const id = await salesforce.createRecord('Device_Command__c', {
    Device__c: deviceId,
    Command__c: 'DISPENSE_MEDICATION',
    Requested_By__c: 'Slack',
    Status__c: 'Pending',
  });
  return `Dispense command queued for \`${deviceId}\` (Device Command ${id}). Its Status in Salesforce shows when the board answers.`;
}

/** The second half: do the Salesforce work and answer on response_url. */
async function respond({ command, deviceId, responseUrl }) {
  if (!SLACK_HOOKS.test(responseUrl) || !DEVICE_NAME.test(deviceId)) {
    throw new Error('refused: a Slack command with no valid response_url or device name');
  }
  let text;
  try {
    text = command === '/patient-status' ? await patientStatus(deviceId) : await dispenseMedication(deviceId);
  } catch (err) {
    // The person sees that it failed; the log keeps what Salesforce said.
    console.error('Slack command failed', { command, deviceId, error: err.message });
    text = `Sorry, \`${command} ${deviceId}\` failed in Salesforce. The function's log says why.`;
  }
  const reply = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', replace_original: true, text }),
  });
  if (!reply.ok) console.error('Slack refused the answer', { status: reply.status });
  return { answered: reply.ok };
}

exports.handler = async (event) => (event && event.slackCommand
  ? respond(event.slackCommand)
  : acknowledge(event));
