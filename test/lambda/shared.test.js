'use strict';

/*
 * lambda/shared: the settings, scoring and Salesforce client the functions
 * share. The functions' own tests exercise these through their handlers; this
 * file pins down the edges those do not reach.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  loadWithFakes, fakeSsm, fakeFetch, jsonResponse, captureConsole, withEnv,
} = require('../helpers/fakes');

const SHARED = path.join(__dirname, '../../lambda/shared');
const THRESHOLDS = require('../../config/vital-thresholds.json');

const loadConfig = (t, parameters, env = {}) => {
  withEnv(t, env);
  const ssm = fakeSsm(parameters);
  const config = loadWithFakes(path.join(SHARED, 'config.js'), { '@aws-sdk/client-ssm': ssm.sdk });
  return { config, ssm };
};

// ---------------------------------------------------------------- config

test('a parameter is read once, then kept for CONFIG_CACHE_SECONDS', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { config, ssm } = loadConfig(t, { '/p': 'one' }, { CONFIG_CACHE_SECONDS: '300' });

  assert.equal(await config.getParameter('/p'), 'one');
  assert.equal(await config.getParameter('/p'), 'one');
  assert.equal(ssm.calls.length, 1);

  ssm.parameters['/p'] = 'two';                   // changed in SSM
  t.mock.timers.tick(301_000);
  assert.equal(await config.getParameter('/p'), 'two');
  assert.equal(ssm.calls.length, 2);
});

test('without CONFIG_CACHE_SECONDS a value is kept until the next cold start', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { config, ssm } = loadConfig(t, { '/p': 'one' }, { CONFIG_CACHE_SECONDS: undefined });
  await config.getParameter('/p');
  t.mock.timers.tick(30 * 86_400_000);
  await config.getParameter('/p');
  assert.equal(ssm.calls.length, 1);
});

test('when SSM fails, the value already held is used, with a warning', async (t) => {
  const lines = captureConsole(t);
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { config, ssm } = loadConfig(t, { '/p': 'one' }, { CONFIG_CACHE_SECONDS: '1' });
  await config.getParameter('/p');
  delete ssm.parameters['/p'];                    // the next read fails
  t.mock.timers.tick(2_000);

  // Failing every reading in a batch because SSM throttled once is worse.
  assert.equal(await config.getParameter('/p'), 'one');
  assert.ok(lines.some((line) => line.includes('SSM read failed; keeping the cached value')));
});

test('with no value held, an SSM failure names the parameter', async (t) => {
  const { config } = loadConfig(t, {});
  await assert.rejects(config.getParameter('/missing'), /Could not read SSM parameter \/missing/);
});

test('a parameter that should be JSON and is not is named', async (t) => {
  const { config } = loadConfig(t, { '/bands': '{ not json' });
  await assert.rejects(config.getJsonParameter('/bands'), /SSM parameter \/bands is not valid JSON/);
});

test('a missing or malformed setting names the variable and where it comes from', (t) => {
  const { config } = loadConfig(t, {}, { A: undefined, B: 'ten', C: 'yes', D: '5', E: 'false' });
  assert.throws(() => config.requiredEnv('A'), /A is not set\. It comes from this function's CloudFormation template\./);
  assert.throws(() => config.numberEnv('B'), /B must be a positive number, not "ten"/);
  assert.throws(() => config.booleanEnv('C'), /C must be "true" or "false", not "yes"/);
  assert.equal(config.numberEnv('D'), 5);
  assert.equal(config.booleanEnv('E'), false);
});

// ---------------------------------------------------------------- vitals

const vitals = () => loadWithFakes(path.join(SHARED, 'vitals.js'), { '@aws-sdk/client-ssm': fakeSsm().sdk });

test('a value on a limit is inside the band; one past it is outside', () => {
  const { assess } = vitals();
  assert.equal(assess({ heartRate: 120 }, THRESHOLDS).riskScore, 15);   // above warning 100, not above critical 120
  assert.equal(assess({ heartRate: 121 }, THRESHOLDS).riskScore, 30);
  assert.equal(assess({ heartRate: 100 }, THRESHOLDS).riskScore, 0);
  assert.deepEqual(assess({ heartRate: 121, spo2: 94 }, THRESHOLDS), {
    riskScore: 50, patientState: 'AT_RISK', critical: ['heartRate'], warning: ['spo2'],
  });
});

test('a vital that was not measured scores nothing', () => {
  const { assess } = vitals();
  // In JavaScript null < 50 is true: unchecked, a missing heart rate is critical.
  for (const missing of [null, undefined, Number.NaN, '130']) {
    assert.equal(assess({ heartRate: missing, spo2: missing }, THRESHOLDS).riskScore, 0, String(missing));
  }
});

test('the score is capped, and the state follows it', () => {
  const { assess } = vitals();
  const everything = { heartRate: 130, spo2: 85, temperature: 40, bpSystolic: 170 };   // 30 + 35 + 25 + 20
  assert.deepEqual(
    [assess(everything, THRESHOLDS).riskScore, assess(everything, THRESHOLDS).patientState],
    [100, 'CRITICAL'],
  );
  assert.equal(assess({ spo2: 94, temperature: 38.6 }, THRESHOLDS).patientState, 'STABLE');   // 20 + 15
  assert.equal(assess({ spo2: 89, temperature: 38.6 }, THRESHOLDS).patientState, 'AT_RISK');  // 35 + 15
});

test('thresholds that cannot be scored with are refused, naming the parameter', async (t) => {
  withEnv(t, { THRESHOLDS_PARAMETER: '/bands' });
  const broken = { ...THRESHOLDS, vitals: [{ field: 'spo2', critical: { below: 90 } }] };
  const ssm = fakeSsm({ '/bands': JSON.stringify(broken) });
  const { loadThresholds, validate } = loadWithFakes(path.join(SHARED, 'vitals.js'), { '@aws-sdk/client-ssm': ssm.sdk });
  await assert.rejects(loadThresholds(), /SSM parameter \/bands: spo2\.critical\.points is missing/);
  assert.equal(validate(THRESHOLDS), null);
  assert.equal(validate({ ...THRESHOLDS, states: { CRITICAL: 70 } }), 'states.CRITICAL and states.AT_RISK are required');
});

// ---------------------------------------------------------------- salesforce

const SF_ENV = {
  SALESFORCE_CLIENT_ID: 'consumer-key',
  SALESFORCE_USERNAME: 'integration@example.com',
  SALESFORCE_LOGIN_URL: 'https://test.salesforce.com',
  SALESFORCE_JWT_KEY_PARAMETER: '/key',
  SALESFORCE_API_VERSION: '62.0',
  SALESFORCE_TOKEN_CACHE_MINUTES: '30',
};

function loadSalesforce(t, respond = () => jsonResponse(200, [])) {
  withEnv(t, SF_ENV);
  let issued = 0;
  const requests = fakeFetch(t, async (request) => {
    if (request.url.endsWith('/services/oauth2/token')) {
      await new Promise((resolve) => setImmediate(resolve));   // slow enough for callers to pile up
      issued += 1;
      return jsonResponse(200, { access_token: `token-${issued}`, instance_url: 'https://acme.my.salesforce.com' });
    }
    return respond(request);
  });
  const signed = [];
  const salesforce = loadWithFakes(path.join(SHARED, 'salesforce.js'), {
    '@aws-sdk/client-ssm': fakeSsm({ '/key': 'pem' }).sdk,
    jsonwebtoken: { sign: (claims, key, options) => { signed.push({ claims, key, options }); return 'assertion'; } },
  });
  const tokenRequests = () => requests.filter((r) => r.url.endsWith('/services/oauth2/token'));
  return { salesforce, requests, tokenRequests, signed };
}

test('callers that arrive together share one token request', async (t) => {
  const { salesforce, tokenRequests } = loadSalesforce(t);
  const sessions = await Promise.all(Array.from({ length: 5 }, () => salesforce.getSession()));
  assert.equal(tokenRequests().length, 1);
  assert.ok(sessions.every((session) => session.accessToken === 'token-1'));
});

test('the token is replaced after SALESFORCE_TOKEN_CACHE_MINUTES', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { salesforce, tokenRequests } = loadSalesforce(t);
  await salesforce.getSession();
  t.mock.timers.tick(29 * 60_000);
  await salesforce.getSession();
  t.mock.timers.tick(2 * 60_000);
  assert.equal((await salesforce.getSession()).accessToken, 'token-2');
  assert.equal(tokenRequests().length, 2);
});

test('the assertion is signed for the configured user and login URL, and short-lived', async (t) => {
  const { salesforce, tokenRequests, signed } = loadSalesforce(t);
  await salesforce.getSession();
  assert.deepEqual(signed, [{
    claims: { iss: 'consumer-key', sub: 'integration@example.com', aud: 'https://test.salesforce.com' },
    key: 'pem',
    options: { algorithm: 'RS256', expiresIn: '3m' },
  }]);
  assert.equal(tokenRequests()[0].url, 'https://test.salesforce.com/services/oauth2/token');
});

test('an action is called on the instance Salesforce returned with the token', async (t) => {
  const { salesforce, requests } = loadSalesforce(t, () => jsonResponse(200, [{ isSuccess: true }]));
  const results = await salesforce.invokeAction('StreamingAlertService', [{ deviceId: 'pm-1' }]);
  const call = requests.find((r) => r.method === 'POST' && !r.url.endsWith('/token'));
  // Not a configured instance name: My Domain renames and sandbox refreshes change it.
  assert.equal(call.url, 'https://acme.my.salesforce.com/services/data/v62.0/actions/custom/apex/StreamingAlertService');
  assert.deepEqual(JSON.parse(call.body), { inputs: [{ deviceId: 'pm-1' }] });
  assert.deepEqual(results, [{ isSuccess: true }]);
});

test('a refused login names the status and what Salesforce said', async (t) => {
  withEnv(t, SF_ENV);
  fakeFetch(t, () => jsonResponse(400, { error: 'invalid_grant', error_description: 'expired authorization code' }));
  const salesforce = loadWithFakes(path.join(SHARED, 'salesforce.js'), {
    '@aws-sdk/client-ssm': fakeSsm({ '/key': 'pem' }).sdk,
    jsonwebtoken: { sign: () => 'assertion' },
  });
  await assert.rejects(salesforce.getSession(), (err) => {
    assert.equal(err.name, 'SalesforceError');
    assert.equal(err.status, 400);
    assert.match(err.message, /JWT auth failed \(400\).*invalid_grant/);
    return true;
  });
});
