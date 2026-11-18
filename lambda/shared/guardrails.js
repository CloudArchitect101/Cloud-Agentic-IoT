'use strict';

/*
 * The guardrails every path to a board shares: which commands may be sent,
 * with which settings, to how many rooms at once; what text an agent's
 * request or answer may carry; and PII masking for what leaves AWS.
 *
 * Why a module and not only a Lambda of its own: a check another function
 * has to remember to call is a check that one day is not called. The
 * device-command function requires this file and runs checkCommand on every
 * request before anything is published, so Salesforce (DeviceCommandSendJob,
 * WiFiCredentialPushJob) and the MCP server's send_device_command both pass
 * through the same rules, in the same process, with no extra hop to fail or
 * to skip. lambda/guardrails deploys the same rules as a function anyone with
 * IAM rights can ask ("would this command be allowed?", "does this answer
 * leak anything?"), but nothing depends on calling it: the enforcement is
 * here. docs/GUARDRAILS-AND-MCP.md explains the choice.
 *
 * The limits mirror what the boards accept (DeviceTiming.h, the sketches),
 * so a command a board would refuse is refused here instead, with a reason,
 * before it reaches the room. test/lambda/guardrails.test.js checks them
 * against the firmware.
 */

// ------------------------------------------------------------------ commands

// What the device API may send, and to how many rooms in one request. Salesforce
// sends Commands_Per_Callout__c rooms per request (200); a request naming more
// is not one Salesforce made.
const MAX_DEVICES_PER_REQUEST = 200;

// Every field each operation may carry, besides commandId, which any command
// may carry (device-command checks its form). A field not listed is refused:
// the patient monitor also reads "command" as the operation, so an extra
// field is not harmless padding, it can change what the board does.
const OPERATIONS = {
  // Turns the medication servo once. One room per request: a dose is for one
  // patient, and nothing in Salesforce sends it to more.
  DISPENSE_MEDICATION: { fields: {}, maxDevices: 1 },
  RESTART: { fields: {} },
  // The patient monitor's motor on or off while a Case waits (CaseAlertService).
  CASE_ALERT: { fields: { active: { type: 'boolean', required: true } } },
  // WiFiCredentialPushJob: one network, every room on it. WPA2 passphrases are
  // 8 to 63 characters, or 64 hex digits; an open network has none.
  WIFI_UPDATE: {
    fields: {
      ssid: { type: 'string', required: true, minBytes: 1, maxBytes: 32 },
      passphrase: { type: 'string', required: false, maxBytes: 64, minBytesUnlessEmpty: 8 },
    },
  },
  // DeviceTiming.h: MIN_TELEMETRY_SECONDS 5, MAX_TELEMETRY_SECONDS 86400.
  SET_TELEMETRY_INTERVAL: {
    fields: { seconds: { type: 'integer', required: true, min: 5, max: 86400 } },
  },
  // DeviceTiming.h: 1 to 60 seconds, 0 to 30 minutes (0 ends live mode).
  LIVE: {
    fields: {
      seconds: { type: 'integer', required: true, min: 1, max: 60 },
      minutes: { type: 'integer', required: true, min: 0, max: 30 },
    },
  },
};

// What an agent outside Salesforce (the MCP server) may ask for: one room at
// a time, and only commands that change how a room is watched, never what is
// given to a patient or the credentials a board holds. A dose needs a
// verified prescription and the day's dose count, which live in Salesforce
// (checkBusinessRules below, and the dispense cooldown there), so an agent
// that cannot show them is refused rather than trusted.
const AGENT_OPERATIONS = new Set(['RESTART', 'CASE_ALERT', 'SET_TELEMETRY_INTERVAL']);
const AGENT_REFUSALS = {
  DISPENSE_MEDICATION: 'dispense_needs_salesforce',
  WIFI_UPDATE: 'credentials_not_for_agents',
};

const PROFILES = ['device-api', 'agent'];

// What each failure code says to a person. A message names fields and
// limits, never a value: a passphrase that is too short must not appear in
// a log line or an answer saying so.
const MESSAGES = {
  unknown_operation: (op) => `${op} is not a command a board takes. Commands: ${Object.keys(OPERATIONS).join(', ')}.`,
  too_many_devices: (max) => `This command goes to at most ${max} room(s) per request.`,
  not_for_agents: (op) => `${op} is not a command an agent may send here. Agents may send: ${[...AGENT_OPERATIONS].join(', ')}.`,
  dispense_needs_salesforce: () => 'DISPENSE_MEDICATION needs a verified prescription and the day\'s dose count, which only Salesforce holds. Create a Device Command there instead.',
  credentials_not_for_agents: () => 'WIFI_UPDATE carries network credentials; an agent may not send them. Use the Wi-Fi Network record in Salesforce.',
  unexpected_field: (field) => `${field} is not a setting this command takes.`,
  missing_field: (field) => `${field} is required for this command.`,
  wrong_type: (field, rule) => `${field} must be ${rule.type === 'integer' ? 'a whole number' : `a ${rule.type}`}.`,
  out_of_range: (field, rule) => `${field} must be from ${rule.min} to ${rule.max}.`,
  wrong_length: (field, rule) => (rule.minBytesUnlessEmpty
    ? `${field} must be empty or ${rule.minBytesUnlessEmpty} to ${rule.maxBytes} bytes.`
    : `${field} must be ${rule.minBytes || 0} to ${rule.maxBytes} bytes.`),
};

/** A name safe to repeat in a message or a log line: what a caller sent as a field name could be anything. */
function safeName(name) {
  const text = String(name);
  return /^[A-Za-z0-9_-]{1,40}$/.test(text) ? text : '(a field with an unprintable name)';
}

/** The failures of one setting against its rule, as [code, message] pairs. */
function checkField(field, value, rule) {
  // Apex sends a blank text field as null: an open Wi-Fi network's
  // Passphrase__c arrives as passphrase: null, which the board reads as none.
  if (value === undefined || (value === null && !rule.required)) {
    return rule.required ? [['missing_field', MESSAGES.missing_field(field)]] : [];
  }
  const typeOk = rule.type === 'integer' ? Number.isInteger(value) : typeof value === rule.type;
  if (!typeOk) return [['wrong_type', MESSAGES.wrong_type(field, rule)]];
  if (rule.type === 'integer' && (value < rule.min || value > rule.max)) {
    return [['out_of_range', MESSAGES.out_of_range(field, rule)]];
  }
  if (rule.type === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8');
    const tooShort = rule.minBytesUnlessEmpty ? bytes > 0 && bytes < rule.minBytesUnlessEmpty : bytes < (rule.minBytes || 0);
    if (tooShort || bytes > rule.maxBytes) return [['wrong_length', MESSAGES.wrong_length(field, rule)]];
  }
  return [];
}

/**
 * Whether one command may be sent.
 *
 *   checkCommand({ operation, fields, deviceCount, profile })
 *     -> { allowed, failures: ['code:field', ...], message }
 *
 * fields: everything the command carries besides its operation and the
 * rooms it names (commandId is checked by device-command). profile
 * 'device-api' (the default) is what Salesforce may send; 'agent' is the
 * narrower set an agent outside Salesforce may. Fails closed: an operation
 * or a field this file does not know is refused.
 */
function checkCommand({ operation, fields = {}, deviceCount = 1, profile = 'device-api' } = {}) {
  const failures = [];
  const messages = [];
  const fail = (code, message) => { failures.push(code); messages.push(message); };

  if (!PROFILES.includes(profile)) {
    fail('unknown_profile', `profile must be one of ${PROFILES.join(', ')}.`);
    return verdict(failures, messages);
  }
  const op = typeof operation === 'string' ? operation : '';
  const spec = Object.hasOwn(OPERATIONS, op) ? OPERATIONS[op] : null;
  if (!spec) {
    fail('unknown_operation', MESSAGES.unknown_operation(safeName(op || '(none)')));
    return verdict(failures, messages);
  }
  if (profile === 'agent' && !AGENT_OPERATIONS.has(op)) {
    const code = AGENT_REFUSALS[op] || 'not_for_agents';
    fail(code, MESSAGES[code](op));
    return verdict(failures, messages);
  }

  const maxDevices = profile === 'agent' ? 1 : (spec.maxDevices || MAX_DEVICES_PER_REQUEST);
  if (!Number.isInteger(deviceCount) || deviceCount < 1 || deviceCount > maxDevices) {
    fail('too_many_devices', MESSAGES.too_many_devices(maxDevices));
  }

  const settings = fields && typeof fields === 'object' ? fields : {};
  for (const field of Object.keys(settings)) {
    if (field === 'commandId') continue;
    if (!Object.hasOwn(spec.fields, field)) fail(`unexpected_field:${safeName(field)}`, MESSAGES.unexpected_field(safeName(field)));
  }
  for (const [field, rule] of Object.entries(spec.fields)) {
    for (const [code, message] of checkField(field, settings[field], rule)) fail(`${code}:${field}`, message);
  }
  return verdict(failures, messages);
}

function verdict(failures, messages) {
  return {
    allowed: failures.length === 0,
    failures,
    message: failures.length ? `Refused by the guardrails: ${messages.join(' ')}` : 'Allowed.',
  };
}

// ---------------------------------------------------------------- PII masking

// The same four patterns, labels and order as PiiMaskingService.cls in
// Salesforce, so text masked on either side reads the same.
// test/lambda/guardrails.test.js fails when the two drift. Email runs before
// phone, or the digits in an address like a1234@x.com are taken as a number.
const PII_PATTERNS = [
  { label: 'EMAIL', pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { label: 'PHONE', pattern: /\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g },
  { label: 'SSN', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: 'HEALTHCARD', pattern: /\b[A-Z]{2}\d{6,9}\b/g },
];

/**
 * Replaces each PII match with a token, [EMAIL_1] and so on; one value seen
 * twice gets one token. Unlike PiiMaskingService there is no restore: what
 * this masks is on its way out of AWS to an agent, and nothing on the way
 * back needs the real value.
 *
 *   maskPii(text) -> { text, masked: <count of distinct values> }
 */
function maskPii(text) {
  if (typeof text !== 'string' || !text) return { text, masked: 0 };
  let working = text;
  let masked = 0;
  for (const { label, pattern } of PII_PATTERNS) {
    const tokens = new Map();
    working = working.replace(pattern, (found) => {
      if (!tokens.has(found)) tokens.set(found, `[${label}_${tokens.size + 1}]`);
      return tokens.get(found);
    });
    masked += tokens.size;
  }
  return { text: working, masked };
}

// ---------------------------------------------------- agent text and actions

// Detection is a tripwire, not a wall. Treat a hit as "route to a human",
// never as "we are now safe" - injection phrasing is unbounded and any
// blocklist is permanently behind.
const INJECTION_SIGNALS = [
  { pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i, label: 'instruction_override' },
  { pattern: /disregard\s+(your|the)\s+(rules|instructions|guidelines)/i, label: 'instruction_override' },
  { pattern: /you\s+are\s+now\s+(a|an)\s+/i, label: 'persona_hijack' },
  // The verbs are grouped: without the parentheses, | splits the whole
  // pattern, so any message containing "reveal" or "print" was flagged.
  { pattern: /(reveal|print|show)\s+(me\s+)?(your|the)\s+(system\s+)?prompt/i, label: 'prompt_extraction' },
  { pattern: /\bpretend\s+(you|to\s+be)\b/i, label: 'persona_hijack' },
];

// Output-side: things an answer must never carry regardless of what was asked.
const OUTPUT_VIOLATIONS = [
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: 'ssn_in_output' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'private_key_in_output' },
  // AWS access key ids: an answer that carries one has leaked a credential.
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, label: 'aws_key_in_output' },
];

function checkInput(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { allowed: true, signals: [] };
  }
  const signals = INJECTION_SIGNALS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => label);

  return {
    // Deliberately not blocking on detection alone. Blocking on a blocklist
    // trains users to rephrase until they get through, and produces false
    // positives on legitimate questions about the system itself.
    allowed: true,
    flagged: signals.length > 0,
    signals: [...new Set(signals)],
    action: signals.length > 0 ? 'REVIEW' : 'PROCEED',
  };
}

function checkOutput(text) {
  if (typeof text !== 'string') return { allowed: true, violations: [] };
  const violations = OUTPUT_VIOLATIONS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => label);

  // Output violations DO block. An SSN in a response is a fact, not a guess,
  // so there is no false-positive tradeoff to weigh here.
  return { allowed: violations.length === 0, violations };
}

/**
 * Business rules the model cannot waive. The agent may decide to dispense
 * medication, but only this function decides whether that is permitted.
 */
function checkBusinessRules(action, context = {}) {
  const failures = [];

  if (action === 'DISPENSE_MEDICATION') {
    if (!context.prescriptionVerified) failures.push('prescription_not_verified');
    // Fails closed. With either count missing, undefined >= undefined is
    // false, which used to let the dose through.
    if (!Number.isFinite(context.dosesInLast24h) || !Number.isFinite(context.maxDailyDoses)) {
      failures.push('dose_history_unknown');
    } else if (context.dosesInLast24h >= context.maxDailyDoses) {
      failures.push('daily_dose_limit_reached');
    }
  }

  if (action === 'ESCALATE' && !context.deviceId) {
    failures.push('escalation_requires_device');
  }

  return { allowed: failures.length === 0, failures };
}

module.exports = {
  OPERATIONS,
  AGENT_OPERATIONS,
  MAX_DEVICES_PER_REQUEST,
  PII_PATTERNS,
  checkCommand,
  maskPii,
  checkInput,
  checkOutput,
  checkBusinessRules,
};
