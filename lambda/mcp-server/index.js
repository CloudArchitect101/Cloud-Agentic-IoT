'use strict';

/**
 * Model Context Protocol (MCP) server for the Smart Ward: each patient room's
 * monitor and medication store as tools any MCP-speaking agent can discover
 * and call.
 *
 * Why MCP rather than a bespoke REST API: the agent discovers the tools at
 * runtime from tools/list, so adding a capability does not require redeploying
 * or re-prompting the agent. The contract is the schema, not the prompt.
 *
 *   get_room_status          one room: its newest reading, whether its board
 *                            is still sending, the patient's state, and
 *                            whether a room-temperature alert is open
 *   list_rooms_out_of_range  every room at or above the room-temperature
 *                            threshold, with an alert open, or gone quiet
 *   send_device_command      one command to one room, through the
 *                            guardrails and the device-command function
 *
 * Transport: MCP's Streamable HTTP, answered as plain JSON (no event stream),
 * behind a Lambda function URL whose auth type is AWS_IAM, so every request
 * is SigV4-signed by an identity allowed to call it (McpClientRole in the
 * template). There is no unauthenticated way in. The server keeps no session:
 * every request stands alone, which is what lets it be a Lambda.
 * docs/GUARDRAILS-AND-MCP.md says how to connect a client.
 *
 * What it reads is the patient-vitals table, the same store the live card's
 * "latest" reads (device-live). What it sends goes through device-command,
 * the same function Salesforce's Device Commands reach through API Gateway:
 * the guardrails in lambda/shared/guardrails.js run there on every command,
 * so this server cannot send what Salesforce could not. It checks the
 * narrower agent profile first, to answer an agent with a reason rather than
 * a 400.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand,
} = require('@aws-sdk/lib-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { isThingName, mapLimit } = require('@cloud-agentic-iot/shared/api');
const { requiredEnv, numberEnv } = require('@cloud-agentic-iot/shared/env');
const {
  checkCommand, checkInput, checkOutput, maskPii, AGENT_OPERATIONS,
} = require('@cloud-agentic-iot/shared/guardrails');

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

// The newest protocol revision first. A client asking for an older one we
// also speak gets it back; any other gets the newest, as the spec says.
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// Newest-reading queries in flight while listing rooms.
const READ_PARALLEL = 8;

const DEVICE_ID = {
  type: 'string',
  description: 'The room monitor\'s AWS IoT Thing name, which is its Asset\'s serial number in Salesforce, e.g. ESP32-Patient-Monitor-01.',
};

/**
 * A tool description is read by the model to decide when to call it, so it is
 * prompt engineering with a schema attached. Vague descriptions produce agents
 * that call the wrong tool confidently.
 */
const TOOLS = [
  {
    name: 'get_room_status',
    title: 'Room status',
    description:
      'Returns the current status of one patient room: the newest temperature and humidity reading '
      + 'from its monitor and when it was taken, whether the monitor is still sending (online, stale '
      + 'or unknown), the patient state and risk score, and whether a room-temperature alert is open '
      + '(Salesforce opens one care team Case per alert). Use it when asked about one room or device.',
    inputSchema: {
      type: 'object',
      properties: { deviceId: DEVICE_ID },
      required: ['deviceId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_rooms_out_of_range',
    title: 'Rooms out of range',
    description:
      'Lists the rooms that need attention now: the newest reading is at or above the room-temperature '
      + 'threshold (30 C unless configured otherwise), a room-temperature alert is open, or the monitor '
      + 'has stopped sending. Each room says why it is listed. Use it when asked which rooms, or how many, '
      + 'are too warm or offline.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'At most this many rooms in the answer (default 25).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'send_device_command',
    title: 'Send a command to one room',
    description:
      'Sends one command to one room\'s monitor: RESTART restarts the board; CASE_ALERT with active true '
      + 'or false turns its alert motor on or off; SET_TELEMETRY_INTERVAL with seconds (5 to 86400) sets '
      + 'how often it reports. Medication and Wi-Fi changes are not available here: they go through '
      + 'Salesforce, which holds the prescription and the credentials. The answer says whether AWS IoT '
      + 'took the command, not whether the board carried it out.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: DEVICE_ID,
        operation: { type: 'string', enum: [...AGENT_OPERATIONS] },
        active: { type: 'boolean', description: 'CASE_ALERT only: true turns the motor on, false off.' },
        seconds: { type: 'integer', minimum: 5, maximum: 86400, description: 'SET_TELEMETRY_INTERVAL only.' },
      },
      required: ['deviceId', 'operation'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

// Earlier names, still answered so an agent that learnt them keeps working.
// Not listed: one name per capability is what keeps a model choosing well.
const ALIASES = { get_device_telemetry: 'get_room_status' };

// A name that was a placeholder and never read real data. The queue's open
// Cases live in Salesforce, which this server does not read.
const RETIRED = {
  get_queue_depth: 'get_queue_depth is retired: it only ever returned a placeholder. Open Cases and the care '
    + 'team queue live in Salesforce; ask the Salesforce agent, or use list_rooms_out_of_range for the rooms '
    + 'with an alert open.',
};

// ------------------------------------------------------------------ transport

exports.handler = async (event) => {
  const method = event && event.requestContext && event.requestContext.http && event.requestContext.http.method;
  if (method && method !== 'POST') {
    // No event stream to open and no session to end: this server answers
    // each POST on its own.
    return http(405, '', { Allow: 'POST' });
  }

  let request;
  try {
    request = readRequest(event);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(request) || !request || typeof request !== 'object' || request.jsonrpc !== '2.0') {
    return rpcError(null, -32600, 'Invalid Request: send one JSON-RPC 2.0 message per POST.', 400);
  }

  const { id, method: rpcMethod, params = {} } = request;
  // A notification (no id) or a client's answer to us needs no reply.
  if (id === undefined || id === null || rpcMethod === undefined) return http(202, '');

  switch (rpcMethod) {
    case 'initialize': {
      const asked = params && params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cloud-agentic-iot-smart-ward', title: 'Smart Ward', version: '2.0.0' },
        instructions: 'Room monitoring for a hospital ward. Read with get_room_status and list_rooms_out_of_range; '
          + 'send_device_command acts on one room at a time and is checked by guardrails outside the model.',
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call':
      return rpcResult(id, await callTool(params || {}));
    default:
      return rpcError(id, -32601, `Method not found: ${String(rpcMethod).slice(0, 60)}`);
  }
};

/** The JSON-RPC message: a function URL's body (maybe base64), a test event's body, or the event itself. */
function readRequest(event) {
  if (!event) return null;
  if (typeof event.body === 'string') {
    const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return JSON.parse(text);
  }
  if (event.body && typeof event.body === 'object') return event.body;
  return event;
}

// --------------------------------------------------------------------- tools

async function callTool(params) {
  const { name, arguments: args = {} } = params;
  if (Object.hasOwn(RETIRED, name)) return toolError(RETIRED[name]);
  const tool = TOOLS.find((t) => t.name === (Object.hasOwn(ALIASES, name) ? ALIASES[name] : name));
  if (!tool) {
    return toolError(`Unknown tool: ${String(name).slice(0, 60)}. Tools: ${TOOLS.map((t) => t.name).join(', ')}.`);
  }

  // A tripwire, not a wall (lambda/shared/guardrails.js): a hit is logged
  // for a person to review, and the call goes on to the rules that decide.
  // First, so an attempt is seen even when the call is malformed too.
  const strings = args && typeof args === 'object' ? Object.values(args).filter((v) => typeof v === 'string') : [];
  const signals = strings.flatMap((v) => checkInput(v).signals || []);
  if (signals.length) console.warn('mcp input flagged', { tool: tool.name, signals: [...new Set(signals)] });

  // Validate against the declared schema rather than trusting the caller.
  // The caller is a language model; required fields go missing.
  const problem = invalidArguments(tool.inputSchema, args);
  if (problem) return toolError(problem);

  try {
    const result = await TOOL_HANDLERS[tool.name](args);
    return toolResult(tool.name, result);
  } catch (err) {
    // Surface the failure as tool output, not as a transport error: the agent
    // can reason about "the room's monitor is offline" but not about an HTTP 500.
    if (err instanceof ToolRefusal) return toolError(err.message);
    console.error('mcp tool failed', { tool: tool.name, error: err.message, name: err.name });
    return toolError(`${tool.name} failed: ${err.message}`);
  }
}

class ToolRefusal extends Error {}

/** The first way args break the tool's schema, or null. Only the schema shapes TOOLS use. */
function invalidArguments(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object.';
  const missing = (schema.required || []).filter((k) => args[k] === undefined);
  if (missing.length) return `Missing required argument(s): ${missing.join(', ')}`;
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (!rule) return `${String(key).slice(0, 40)} is not an argument of this tool.`;
    if (rule.type === 'integer' && !Number.isInteger(value)) return `${key} must be a whole number.`;
    if (rule.type !== 'integer' && typeof value !== rule.type) return `${key} must be a ${rule.type}.`;
    if (rule.enum && !rule.enum.includes(value)) return `${key} must be one of ${rule.enum.join(', ')}.`;
    if (rule.minimum !== undefined && value < rule.minimum) return `${key} must be at least ${rule.minimum}.`;
    if (rule.maximum !== undefined && value > rule.maximum) return `${key} must be at most ${rule.maximum}.`;
  }
  if (args.deviceId !== undefined && !isThingName(args.deviceId)) {
    return 'deviceId must be an AWS IoT Thing name: letters, digits, : _ and -, up to 128 characters.';
  }
  return null;
}

const TOOL_HANDLERS = {
  get_room_status: ({ deviceId }) => roomStatus(deviceId),
  list_rooms_out_of_range: ({ limit = 25 }) => roomsOutOfRange(limit),
  send_device_command: (args) => sendCommand(args),
};

/** What the rules compare with, from the template. */
function settings() {
  return {
    table: requiredEnv('TABLE_NAME'),
    thresholdC: numberEnv('ROOM_TEMP_ALERT_CELSIUS'),
    offlineAfterMinutes: numberEnv('OFFLINE_AFTER_MINUTES'),
  };
}

async function roomStatus(deviceId) {
  const config = settings();
  const [reading, state] = await Promise.all([newestReading(config.table, deviceId), stateOf(config.table, deviceId)]);
  if (!reading && !state) {
    throw new ToolRefusal(`No room monitor called ${deviceId} has reported to AWS. Check the name: it is the Asset's serial number.`);
  }
  return describeRoom(deviceId, reading, state, config, Date.now());
}

/**
 * One room, as the tools report it. An alert is "open" from the first
 * reading at or above the threshold until one drops a degree below it: the
 * STATE item's RoomTempHot, which patient-vitals keeps, and which is what
 * makes Salesforce open one Case per episode (RoomTemperatureCaseService).
 */
function describeRoom(deviceId, reading, state, config, now) {
  const lastSeenMs = reading && reading.at ? Date.parse(reading.at) : NaN;
  let connectivity = 'unknown';
  if (Number.isFinite(lastSeenMs)) {
    connectivity = now - lastSeenMs > config.offlineAfterMinutes * 60000 ? 'stale' : 'online';
  }
  const temperature = reading ? reading.temperature : null;
  return {
    deviceId,
    latestReading: reading,
    connectivity: {
      status: connectivity,
      lastSeen: reading ? reading.at : null,
      offlineAfterMinutes: config.offlineAfterMinutes,
      ...(connectivity === 'unknown' && {
        note: 'No stored reading to judge by: this environment may keep no readings in DynamoDB. The Asset in Salesforce shows whether the board is connected.',
      }),
    },
    patient: state && {
      state: state.PatientState,
      riskScore: state.RiskScore,
      updatedAt: state.UpdatedAt,
    },
    roomTemperatureAlert: {
      thresholdC: config.thresholdC,
      atOrAboveThreshold: temperature === null ? null : temperature >= config.thresholdC,
      alertOpen: Boolean(state && state.RoomTempHot === true),
    },
  };
}

async function roomsOutOfRange(limit) {
  const config = settings();
  const maxRooms = numberEnv('MAX_ROOMS_SCANNED');
  const { states, truncated } = await allStates(config.table, maxRooms);
  const now = Date.now();
  const rooms = await mapLimit(states, READ_PARALLEL, async (state) => {
    const deviceId = state.PK.slice('PATIENT#'.length);
    return describeRoom(deviceId, await newestReading(config.table, deviceId), state, config, now);
  });

  const listed = [];
  let unknown = 0;
  for (const room of rooms) {
    const reasons = [];
    if (room.roomTemperatureAlert.atOrAboveThreshold) reasons.push(`temperature at or above ${config.thresholdC} C`);
    if (room.roomTemperatureAlert.alertOpen) reasons.push('room-temperature alert open');
    if (room.connectivity.status === 'stale') reasons.push(`no reading for over ${config.offlineAfterMinutes} minutes`);
    if (room.connectivity.status === 'unknown') unknown += 1;
    if (reasons.length) {
      listed.push({
        deviceId: room.deviceId,
        reasons,
        temperature: room.latestReading ? room.latestReading.temperature : null,
        lastSeen: room.connectivity.lastSeen,
        patientState: room.patient ? room.patient.state : null,
      });
    }
  }
  listed.sort((a, b) => (b.temperature ?? -Infinity) - (a.temperature ?? -Infinity) || a.deviceId.localeCompare(b.deviceId));
  return {
    thresholdC: config.thresholdC,
    offlineAfterMinutes: config.offlineAfterMinutes,
    roomsChecked: rooms.length,
    roomsOutOfRange: listed.length,
    rooms: listed.slice(0, limit),
    ...(listed.length > limit && { moreNotShown: listed.length - limit }),
    ...(truncated && { note: `Only the first ${maxRooms} rooms were checked (MAX_ROOMS_SCANNED).` }),
    ...(unknown && { roomsWithUnknownConnectivity: unknown }),
  };
}

/**
 * Every room's STATE item, up to maxRooms. A Scan reads the whole table, the
 * stored readings too where they are kept, and filters after reading, so it
 * costs what the table holds, not what it returns: fine for a ward, and
 * capped by MAX_ROOMS_SCANNED for anything bigger. docs/GUARDRAILS-AND-MCP.md
 * says what to build before a fleet of thousands.
 */
async function allStates(table, maxRooms) {
  const states = [];
  let start;
  do {
    const page = await dynamodb.send(new ScanCommand({
      TableName: table,
      FilterExpression: 'SK = :state',
      ExpressionAttributeValues: { ':state': 'STATE' },
      ProjectionExpression: 'PK, SK, PatientState, RiskScore, UpdatedAt, RoomTempHot',
      ...(start && { ExclusiveStartKey: start }),
    }));
    for (const item of page.Items || []) {
      if (typeof item.PK === 'string' && item.PK.startsWith('PATIENT#')) states.push(item);
    }
    start = page.LastEvaluatedKey;
  } while (start && states.length < maxRooms);
  return { states: states.slice(0, maxRooms), truncated: states.length > maxRooms || Boolean(start) };
}

/** The room's newest stored reading, or null. Readings are keyed PATIENT#<thing> / VITAL#<timestamp>. */
async function newestReading(table, deviceId) {
  const { Items = [] } = await dynamodb.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: 'PK = :device AND begins_with(SK, :reading)',
    ExpressionAttributeValues: { ':device': `PATIENT#${deviceId}`, ':reading': 'VITAL#' },
    ScanIndexForward: false,
    Limit: 1,
  }));
  if (!Items.length) return null;
  const item = Items[0];
  const reading = {
    temperature: numberOrNull(item.Temperature),
    humidity: numberOrNull(item.Humidity),
    at: isoOrNull(item.CreatedAt) || isoOrNull(item.SK.slice('VITAL#'.length)),
  };
  if (numberOrNull(item.HeartRate) !== null) reading.heartRate = item.HeartRate;
  if (numberOrNull(item.SpO2) !== null) reading.spo2 = item.SpO2;
  return reading;
}

async function stateOf(table, deviceId) {
  const { Item } = await dynamodb.send(new GetCommand({ TableName: table, Key: { PK: `PATIENT#${deviceId}`, SK: 'STATE' } }));
  return Item || null;
}

/**
 * One command to one room. The agent profile is checked here so the agent
 * hears why; device-command checks the device API's rules again on its own,
 * so a fault in this file still cannot send what Salesforce could not.
 */
async function sendCommand({ deviceId, operation, active, seconds }) {
  const fields = {};
  if (active !== undefined) fields.active = active;
  if (seconds !== undefined) fields.seconds = seconds;
  const verdict = checkCommand({ operation, fields, deviceCount: 1, profile: 'agent' });
  if (!verdict.allowed) {
    console.warn('mcp command refused by guardrails', { deviceId, operation, failures: verdict.failures });
    throw new ToolRefusal(verdict.message);
  }

  const response = await lambda.send(new InvokeCommand({
    FunctionName: requiredEnv('DEVICE_COMMAND_FUNCTION'),
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify({ body: JSON.stringify({ thingName: deviceId, operation, ...fields }) })),
  }));
  let answer = null;
  try {
    answer = JSON.parse(Buffer.from(response.Payload || []).toString('utf8'));
  } catch {
    // Read as a failure below.
  }
  if (response.FunctionError || !answer || typeof answer.statusCode !== 'number') {
    throw new Error('the device-command function did not answer. Nothing is known to have reached the room.');
  }
  let body = {};
  try {
    body = JSON.parse(answer.body);
  } catch {
    // Keep {}.
  }
  if (answer.statusCode !== 200) {
    throw new ToolRefusal(`Not sent: ${body.error || `device-command answered ${answer.statusCode}`}`);
  }
  console.log('mcp command sent', { deviceId, operation });
  return {
    deviceId,
    operation,
    published: true,
    note: 'AWS IoT took the command for this room. The board carries it out if it is online; this path records no Device Command in Salesforce.',
  };
}

// ----------------------------------------------------------------- answers

/**
 * A tool's answer, masked and checked on its way out (lambda/shared/guardrails.js):
 * PII becomes a token, and an answer that still carries a key or a
 * credential is withheld rather than sent.
 */
function toolResult(tool, result) {
  const { text, masked } = maskPii(JSON.stringify(result, null, 2));
  const check = checkOutput(text);
  if (!check.allowed) {
    console.error('mcp output withheld', { tool, violations: check.violations });
    return toolError(`The answer from ${tool} was withheld by the output guardrail (${check.violations.join(', ')}).`);
  }
  if (masked) console.log('mcp output masked', { tool, masked });
  let structuredContent;
  try {
    structuredContent = JSON.parse(text);
  } catch {
    // Text only.
  }
  return { content: [{ type: 'text', text }], ...(structuredContent && { structuredContent }), isError: false };
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoOrNull(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

const rpcResult = (id, result) => json(200, { jsonrpc: '2.0', id, result });
const rpcError = (id, code, message, status = 200) => json(status, { jsonrpc: '2.0', id, error: { code, message } });

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function http(statusCode, body, headers = {}) {
  return { statusCode, headers, body };
}

exports.TOOLS = TOOLS;
