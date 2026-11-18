'use strict';

/*
 * Salesforce REST client for the Lambdas: JWT bearer flow, one token per
 * container, sObject Collections for writes.
 *
 * The functions this replaces signed a JWT and fetched a new access token for
 * every single call, and wrote one record per request. At a million devices
 * that is two Salesforce API calls per alert, and a token request is the
 * slowest call of all. Here a token is fetched once and reused until
 * SALESFORCE_TOKEN_CACHE_MINUTES pass, or until Salesforce answers 401, and a
 * write carries up to 200 records.
 *
 * Settings, all from the function's template:
 *   SALESFORCE_CLIENT_ID          the integration External Client App's consumer key
 *   SALESFORCE_USERNAME           the integration user
 *   SALESFORCE_LOGIN_URL          https://login.salesforce.com or https://test.salesforce.com
 *   SALESFORCE_JWT_KEY_PARAMETER  SSM SecureString holding the PEM private key
 *   SALESFORCE_API_VERSION        e.g. 62.0
 *   SALESFORCE_TOKEN_CACHE_MINUTES  shorter than the org's session timeout
 *
 * The instance URL is not a setting: Salesforce returns it with the token,
 * and it is the only one that is always right (My Domain renames, sandbox
 * refreshes and instance moves all change it).
 */

const jwt = require('jsonwebtoken');
const { getParameter, requiredEnv, numberEnv } = require('./config');

// sObject Collections accepts at most 200 records per request.
const COLLECTION_LIMIT = 200;

let session = null;   // { accessToken, instanceUrl, expiresAt }
let pending = null;   // the token request in flight, shared by everyone waiting on it

class SalesforceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SalesforceError';
    this.status = status;
  }
}

async function authenticate() {
  const loginUrl = requiredEnv('SALESFORCE_LOGIN_URL');
  const privateKey = await getParameter(requiredEnv('SALESFORCE_JWT_KEY_PARAMETER'), { decrypt: true });

  // JWT Bearer Flow: a signed assertion exchanged for a short-lived token.
  // No password exists anywhere in this system.
  const assertion = jwt.sign(
    { iss: requiredEnv('SALESFORCE_CLIENT_ID'), sub: requiredEnv('SALESFORCE_USERNAME'), aud: loginUrl },
    privateKey,
    { algorithm: 'RS256', expiresIn: '3m' },
  );
  const response = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!response.ok) {
    throw new SalesforceError(`Salesforce JWT auth failed (${response.status}): ${await response.text()}`, response.status);
  }
  const { access_token: accessToken, instance_url: instanceUrl } = await response.json();
  session = {
    accessToken,
    instanceUrl,
    expiresAt: Date.now() + numberEnv('SALESFORCE_TOKEN_CACHE_MINUTES') * 60_000,
  };
  return session;
}

/**
 * The current session, fetching a token only when there is none or it is due.
 * Calls that arrive while a token is being fetched wait for that one request
 * instead of each starting their own.
 */
async function getSession({ refresh = false } = {}) {
  if (!refresh && session && session.expiresAt > Date.now()) return session;
  if (!pending) {
    pending = authenticate().finally(() => { pending = null; });
  }
  return pending;
}

/**
 * One REST call, authenticated. A 401 means the session ended early (an
 * admin revoked it, or the org's timeout is shorter than our cache): fetch a
 * new token once and try again.
 */
async function call(method, path, body) {
  const send = (current) => fetch(`${current.instanceUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${current.accessToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let response = await send(await getSession());
  if (response.status === 401) {
    response = await send(await getSession({ refresh: true }));
  }
  return response;
}

function apiPath(rest) {
  return `/services/data/v${requiredEnv('SALESFORCE_API_VERSION')}${rest}`;
}

/**
 * Upserts records on an external ID, 200 per request, and returns one result
 * per record, in order: { id, success, created, errors }. One bad record does
 * not fail the others (allOrNone false); the caller decides what to do with
 * each failure. A request that fails as a whole throws.
 */
async function upsertCollection(sobject, externalIdField, records) {
  const results = [];
  for (let i = 0; i < records.length; i += COLLECTION_LIMIT) {
    const chunk = records.slice(i, i + COLLECTION_LIMIT);
    const response = await call('PATCH', apiPath(`/composite/sobjects/${sobject}/${externalIdField}`), {
      allOrNone: false,
      records: chunk.map((record) => ({ attributes: { type: sobject }, ...record })),
    });
    if (!response.ok) {
      throw new SalesforceError(`Salesforce upsert failed (${response.status}): ${await response.text()}`, response.status);
    }
    results.push(...(await response.json()));
  }
  return results;
}

/** Calls an invocable Apex action with a list of inputs; one result per input. */
async function invokeAction(className, inputs) {
  const response = await call('POST', apiPath(`/actions/custom/apex/${className}`), { inputs });
  if (!response.ok) {
    throw new SalesforceError(`Salesforce returned ${response.status}: ${await response.text()}`, response.status);
  }
  return response.json();
}

module.exports = { getSession, upsertCollection, invokeAction, SalesforceError, COLLECTION_LIMIT };
