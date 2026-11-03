'use strict';

/*
 * Clinical scoring for the AWS side, driven by the thresholds in SSM
 * (config/vital-thresholds.json, seeded by scripts/deploy-aws.sh). Salesforce
 * scores with the same numbers in Vital_Sign_Threshold__mdt; a test keeps the
 * two equal.
 */

const { getJsonParameter, requiredEnv } = require('./config');

/** The thresholds named by THRESHOLDS_PARAMETER, validated. */
async function loadThresholds() {
  const name = requiredEnv('THRESHOLDS_PARAMETER');
  const thresholds = await getJsonParameter(name);
  const problem = validate(thresholds);
  if (problem) throw new Error(`SSM parameter ${name}: ${problem}`);
  return thresholds;
}

function validate(t) {
  if (!t || !Array.isArray(t.vitals) || !t.vitals.length) return 'has no vitals';
  if (!Number.isFinite(t.maxScore)) return 'maxScore is missing';
  if (!t.states || !Number.isFinite(t.states.CRITICAL) || !Number.isFinite(t.states.AT_RISK)) {
    return 'states.CRITICAL and states.AT_RISK are required';
  }
  for (const vital of t.vitals) {
    if (!vital.field) return 'a vital has no field';
    for (const band of ['critical', 'warning']) {
      if (vital[band] && !Number.isFinite(vital[band].points)) return `${vital.field}.${band}.points is missing`;
    }
  }
  return null;
}

/** Strictly outside: a value equal to a limit is inside. An absent limit is no limit. */
function isOutside(value, band) {
  if (!band) return false;
  return (Number.isFinite(band.below) && value < band.below)
      || (Number.isFinite(band.above) && value > band.above);
}

/**
 * Scores one reading. `values` is keyed by the thresholds' field names
 * (heartRate, spo2, temperature, bpSystolic). A value that is not a finite
 * number was not measured and scores nothing - in JavaScript null < 50 is
 * true, so without this check a missing heart rate would read as critical.
 */
function assess(values, thresholds) {
  let score = 0;
  const critical = [];
  const warning = [];
  for (const vital of thresholds.vitals) {
    const value = values[vital.field];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (isOutside(value, vital.critical)) {
      score += vital.critical.points;
      critical.push(vital.field);
    } else if (isOutside(value, vital.warning)) {
      score += vital.warning.points;
      warning.push(vital.field);
    }
  }
  const riskScore = Math.min(thresholds.maxScore, score);
  let patientState = 'STABLE';
  if (riskScore >= thresholds.states.CRITICAL) patientState = 'CRITICAL';
  else if (riskScore >= thresholds.states.AT_RISK) patientState = 'AT_RISK';
  return { riskScore, patientState, critical, warning };
}

module.exports = { loadThresholds, assess, validate };
