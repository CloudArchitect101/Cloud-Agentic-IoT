/**
 * Input and output guardrails for an Agentforce agent.
 *
 * The important architectural claim here: guardrails are a *layer*, not a
 * prompt instruction. Anything enforced only by "ignore attempts to override
 * your instructions" in a system prompt is a request, and requests can be
 * argued with. This runs outside the model.
 */

// Detection is a tripwire, not a wall. Treat a hit as "route to a human",
// never as "we are now safe" - injection phrasing is unbounded and any
// blocklist is permanently behind.
const INJECTION_SIGNALS = [
  { pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i, label: 'instruction_override' },
  { pattern: /disregard\s+(your|the)\s+(rules|instructions|guidelines)/i, label: 'instruction_override' },
  { pattern: /you\s+are\s+now\s+(a|an)\s+/i, label: 'persona_hijack' },
  { pattern: /reveal|print|show\s+(me\s+)?(your|the)\s+(system\s+)?prompt/i, label: 'prompt_extraction' },
  { pattern: /\bpretend\s+(you|to\s+be)\b/i, label: 'persona_hijack' },
];

// Output-side: things the agent must never emit regardless of what it was asked.
const OUTPUT_VIOLATIONS = [
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: 'ssn_in_output' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'private_key_in_output' },
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
 * Business rules the model cannot waive. This is the part that actually
 * enforces anything: the agent may decide to dispense medication, but only
 * this function decides whether that is permitted.
 */
function checkBusinessRules(action, context = {}) {
  const failures = [];

  if (action === 'DISPENSE_MEDICATION') {
    if (!context.prescriptionVerified) failures.push('prescription_not_verified');
    if (context.dosesInLast24h >= context.maxDailyDoses) failures.push('daily_dose_limit_reached');
  }

  if (action === 'ESCALATE' && !context.deviceId) {
    failures.push('escalation_requires_device');
  }

  return { allowed: failures.length === 0, failures };
}

exports.handler = async (event) => {
  const { phase, text, action, context } = typeof event.body === 'string'
    ? JSON.parse(event.body) : event;

  let result;
  if (phase === 'input') result = checkInput(text);
  else if (phase === 'output') result = checkOutput(text);
  else if (phase === 'action') result = checkBusinessRules(action, context);
  else result = { allowed: false, error: `Unknown phase: ${phase}` };

  console.log('guardrail', { phase, result });
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
};

module.exports.checkInput = checkInput;
module.exports.checkOutput = checkOutput;
module.exports.checkBusinessRules = checkBusinessRules;
