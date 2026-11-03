'use strict';

/*
 * Settings from the environment, which each function's CloudFormation
 * template sets from config/<env>.json. A missing or malformed one fails with
 * its name, not as a NaN three calls later.
 *
 * Kept apart from config.js so a function that reads no SSM parameters does
 * not load the SSM client.
 */

/** The environment variable's value; a missing one is a template defect, named as such. */
function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. It comes from this function's CloudFormation template.`);
  }
  return value;
}

/** A positive number from the environment, or the error that names it. */
function numberEnv(name) {
  const value = Number(requiredEnv(name));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, not "${process.env[name]}".`);
  }
  return value;
}

/** "true" or "false" from the environment; anything else is a template defect. */
function booleanEnv(name) {
  const value = requiredEnv(name);
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${name} must be "true" or "false", not "${value}".`);
  }
  return value === 'true';
}

module.exports = { requiredEnv, numberEnv, booleanEnv };
