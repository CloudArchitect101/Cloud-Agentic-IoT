'use strict';

/*
 * Runtime settings from SSM Parameter Store.
 *
 * What a function needs to know at runtime - its Salesforce private key, the
 * clinical thresholds - is read from Parameter Store when it is first needed
 * and kept for CONFIG_CACHE_SECONDS, so a change in SSM reaches every running
 * function within that time and no redeploy is needed. A SecureString is
 * decrypted here, in memory: it never sits in an environment variable, where
 * anyone with lambda:GetFunctionConfiguration could read it.
 */

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { requiredEnv, numberEnv, booleanEnv } = require('./env');

const ssm = new SSMClient({});
const cache = new Map();

function cacheMillis() {
  // Unset: keep values for the life of the container (until the next cold start).
  const seconds = process.env.CONFIG_CACHE_SECONDS;
  return seconds === undefined || seconds === '' ? Infinity : Number(seconds) * 1000;
}

async function getParameter(name, { decrypt = false } = {}) {
  const hit = cache.get(name);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let result;
  try {
    result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: decrypt }));
  } catch (err) {
    if (hit) {
      // SSM throttled or briefly unreachable: the value we already have is
      // better than failing every reading in the batch.
      console.warn('SSM read failed; keeping the cached value', { name, error: err.message });
      return hit.value;
    }
    throw new Error(`Could not read SSM parameter ${name}: ${err.message}`);
  }
  const value = result.Parameter.Value;
  cache.set(name, { value, expiresAt: Date.now() + cacheMillis() });
  return value;
}

async function getJsonParameter(name) {
  const text = await getParameter(name);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`SSM parameter ${name} is not valid JSON: ${err.message}`);
  }
}

module.exports = {
  getParameter, getJsonParameter, requiredEnv, numberEnv, booleanEnv,
};
