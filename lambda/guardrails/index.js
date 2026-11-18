'use strict';

/**
 * Input, output, action and command guardrails for an agent, as a function.
 *
 * The important architectural claim here: guardrails are a *layer*, not a
 * prompt instruction. Anything enforced only by "ignore attempts to override
 * your instructions" in a system prompt is a request, and requests can be
 * argued with. This runs outside the model.
 *
 * The rules live in lambda/shared/guardrails.js, which device-command and the
 * MCP server also require, so this function answers exactly what those two
 * enforce. It is a place to ask, not a gate anything must pass: the gate is
 * the shared module inside device-command (docs/GUARDRAILS-AND-MCP.md).
 *
 *   { phase: 'input',   text }                  -> { allowed, flagged, signals, action }
 *   { phase: 'output',  text }                  -> { allowed, violations }
 *   { phase: 'mask',    text }                  -> { text, masked }
 *   { phase: 'action',  action, context }       -> { allowed, failures }
 *   { phase: 'command', operation, fields, deviceCount, profile }
 *                                               -> { allowed, failures, message }
 *
 * It has no trigger and no URL: a caller needs lambda:InvokeFunction on it,
 * which only this account's own identities can be given.
 */

const {
  checkInput, checkOutput, checkBusinessRules, checkCommand, maskPii,
} = require('@cloud-agentic-iot/shared/guardrails');

exports.handler = async (event) => {
  let request;
  try {
    request = typeof (event && event.body) === 'string' ? JSON.parse(event.body) : (event || {});
  } catch {
    return answer(400, { allowed: false, error: 'Body is not valid JSON' });
  }
  const {
    phase, text, action, context, operation, fields, deviceCount, profile,
  } = request || {};

  let result;
  if (phase === 'input') result = checkInput(text);
  else if (phase === 'output') result = checkOutput(text);
  else if (phase === 'mask') result = maskPii(text);
  else if (phase === 'action') result = checkBusinessRules(action, context);
  else if (phase === 'command') result = checkCommand({ operation, fields, deviceCount, profile });
  else result = { allowed: false, error: `Unknown phase: ${typeof phase === 'string' ? phase.slice(0, 40) : phase}` };

  // The verdict only, never the text or the fields: what was checked may be
  // the very thing that must not be logged (a passphrase, a patient's details).
  const { text: _maskedText, ...verdict } = result;
  console.log('guardrail', { phase, ...verdict });
  return answer(200, result);
};

function answer(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

module.exports.checkInput = checkInput;
module.exports.checkOutput = checkOutput;
module.exports.checkBusinessRules = checkBusinessRules;
module.exports.checkCommand = checkCommand;
module.exports.maskPii = maskPii;
