'use strict';

// The aws-spend function (lambda/aws-spend): this month's AWS spend and its
// limit for the usage card on the app's Home page. A budget gives both, read
// on every page load at no charge. With no budget, Cost Explorer is asked
// only when it is turned on, and only after a claim on the cache parameter
// was written, so a failing SSM can never turn page loads into paid requests.
// Budgets, Cost Explorer and SSM are faked.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  loadWithFakes, fakeAwsSdk, awsError, captureConsole, withEnv,
} = require('../helpers/fakes');

const HANDLER = path.join(__dirname, '../../lambda/aws-spend/index.js');
const ACCOUNT = '111122223333';
const OURS = 'cloud-agentic-iot-monthly';
const PARAMETER = '/cloud-agentic-iot/cache/aws-spend';
const SETTINGS = {
  ACCOUNT_ID: ACCOUNT,
  SPEND_CACHE_PARAMETER: PARAMETER,
  SPEND_CACHE_HOURS: '24',
  SPEND_COST_EXPLORER: 'false',
  SPEND_LIMIT_BUDGET_NAME: OURS,
};
const CE_ON = { SPEND_COST_EXPLORER: 'true' };
const NOW = '2026-11-06T17:20:05.000Z';
const HOUR = 60 * 60 * 1000;
const NOT_COUNTED = { Not: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Credit', 'Refund', 'Tax'] } } };
const SERVICE = { Dimensions: { Key: 'SERVICE', Values: ['Amazon Elastic Compute Cloud - Compute'] } };

const NOTICE = {
  notCalculated: "AWS has not calculated this budget's spend yet. It recalculates budgets about every 8 to 12 hours.",
  newMonth: "A new month began at 00:00 UTC. AWS can take up to a day to show this month's spend, "
    + 'and a budget may show a stale figure until it recalculates.',
  noBudget: 'No monthly cost budget found, so there is no spend to show. Create the budget cloud-agentic-iot-monthly, '
    + "which AWS lists no charge for reading. In an AWS project, set its amount to the project's spend limit.",
  ceOff: 'Cost Explorer is not enabled in this account. Create the budget cloud-agentic-iot-monthly instead; '
    + 'the card reads budgets at no charge.',
  ceNoData: 'Cost Explorer has no data for this month yet.',
  cePending: 'Cost Explorer is being asked right now. Reload the page in a minute.',
};

const budget = (name, amount, extra = {}) => ({
  BudgetName: name,
  BudgetType: 'COST',
  TimeUnit: 'MONTHLY',
  BudgetLimit: { Amount: String(amount), Unit: 'USD' },
  CalculatedSpend: { ActualSpend: { Amount: '3.4249', Unit: 'USD' } },
  ...extra,
});

const later = (iso, millis) => new Date(Date.parse(iso) + millis).toISOString();

/**
 * A fresh handler with fake Budgets, Cost Explorer and SSM. Every call to any
 * of them goes into one list, in order, as "Command" and its input.
 *   budgets   what DescribeBudgets lists, or describe(input) to answer or throw
 *   ce(input) what GetCostAndUsage answers or throws (default: $3.4249, estimated)
 *   kept      the parameter's value; undefined means it does not exist
 *   get/put   throw from these to fail SSM reads or writes
 */
function load(t, {
  budgets = [], describe, ce, kept, get, put, env = {},
} = {}) {
  withEnv(t, { ...SETTINGS, ...env });
  const calls = [];
  const store = { value: kept };
  const record = (command, input) => calls.push({ command, input });

  const b = fakeAwsSdk('BudgetsClient', ['DescribeBudgetsCommand'], (command, input) => {
    record(command, input);
    return describe ? describe(input) : { Budgets: budgets };
  });
  const c = fakeAwsSdk('CostExplorerClient', ['GetCostAndUsageCommand'], (command, input) => {
    record(command, input);
    return ce ? ce(input) : { ResultsByTime: [{ Total: { UnblendedCost: { Amount: '3.4249', Unit: 'USD' } }, Estimated: true }] };
  });
  const s = fakeAwsSdk('SSMClient', ['GetParameterCommand', 'PutParameterCommand'], (command, input) => {
    record(command, input);
    if (command === 'GetParameterCommand') {
      if (get) get(input);
      if (store.value === undefined) throw awsError('ParameterNotFound', `Parameter ${input.Name} not found.`);
      return { Parameter: { Name: input.Name, Value: store.value } };
    }
    if (put) put(input);
    store.value = input.Value;
    return {};
  });

  // Each client's settings, by client name, as the function built them.
  const configs = {};
  for (const [fake, name] of [[b, 'BudgetsClient'], [c, 'CostExplorerClient'], [s, 'SSMClient']]) {
    const Base = fake.sdk[name];
    fake.sdk[name] = class extends Base {
      constructor(config) {
        super();
        configs[name] = config;
      }
    };
  }

  const { handler } = loadWithFakes(HANDLER, {
    '@aws-sdk/client-budgets': b.sdk,
    '@aws-sdk/client-cost-explorer': c.sdk,
    '@aws-sdk/client-ssm': s.sdk,
  });
  return {
    handler,
    calls,
    configs,
    store,
    commands: () => calls.map((call) => call.command),
    kept: () => JSON.parse(store.value),
  };
}

const ask = (handler, body = {}) => handler({ body: JSON.stringify(body) });
const answer = (res) => JSON.parse(res.body);
const at = (t, iso) => t.mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });
const budgetCalls = ['DescribeBudgetsCommand'];

test('a budget gives both numbers, to the cent, from one free call', async (t) => {
  captureConsole(t);
  at(t, NOW);
  const fn = load(t, { budgets: [budget(OURS, 20, { FilterExpression: NOT_COUNTED })], env: CE_ON });

  const res = await ask(fn.handler);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(answer(res), {
    month: '2026-11',
    currency: 'USD',
    spent: {
      amount: 3.42, source: 'budget', basis: 'pre-credit-pre-tax', estimated: null, asOf: NOW, keptUntil: null,
    },
    limit: {
      amount: 20, source: 'budget', name: OURS, chosenBy: 'name',
    },
    notices: [],
  });
  assert.deepEqual(fn.calls, [{
    command: 'DescribeBudgetsCommand',
    input: { AccountId: ACCOUNT, MaxResults: 100, ShowFilterExpression: true },
  }], 'no Cost Explorer and no SSM, even with Cost Explorer on');
});

test('the named budget wins over a larger one; without it, the largest that counts every service over $1 wins', async (t) => {
  captureConsole(t);
  at(t, NOW);
  const named = load(t, { budgets: [budget('alerts', 50), budget(OURS, 20, { FilterExpression: NOT_COUNTED })] });
  assert.deepEqual(answer(await ask(named.handler)).limit, {
    amount: 20, source: 'budget', name: OURS, chosenBy: 'name',
  });

  const skipped = [
    budget('My Zero-Spend Budget', 1),
    budget('nothing', 0),
    budget('daily', 1000, { TimeUnit: 'DAILY' }),
    budget('hours', 900, { BudgetType: 'USAGE' }),
    budget('in another unit', 800, { BudgetLimit: { Amount: '800', Unit: 'GB' } }),
    budget('ec2 only', 700, { FilterExpression: SERVICE }),
    budget('ec2 the old way', 600, { CostFilters: { Service: ['Amazon Elastic Compute Cloud - Compute'] } }),
    budget('one tag', 500, { FilterExpression: { Tags: { Key: 'env', Values: ['dev'] } } }),
    budget('a category', 400, { FilterExpression: { CostCategories: { Key: 'team', Values: ['iot'] } } }),
    budget('not ec2', 300, { FilterExpression: { Not: SERVICE } }),
    budget('no amount', 9999, { BudgetLimit: { Unit: 'USD' } }),
    // The named budget too, when it counts only some services.
    budget(OURS, 5000, { FilterExpression: SERVICE }),
  ];
  const largest = load(t, { budgets: [...skipped, budget('b-limit', 20), budget('a-limit', 20)] });
  // The same amount twice: the first name in alphabetical order.
  assert.deepEqual(answer(await ask(largest.handler)).limit, {
    amount: 20, source: 'budget', name: 'a-limit', chosenBy: 'largest',
  });

  const none = load(t, { budgets: skipped });
  assert.equal(answer(await ask(none.handler)).limit, null, 'every one of those is skipped');
});

test('a filter on charge types alone still counts every service', async (t) => {
  captureConsole(t);
  at(t, NOW);
  const support = { Not: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Support'] } } };
  const forms = [
    { FilterExpression: NOT_COUNTED },
    { FilterExpression: { And: [NOT_COUNTED, support] } },
    // A budget may carry both forms; FilterExpression is the whole filter.
    { CostFilters: { RecordType: ['Credit'] }, FilterExpression: { And: [NOT_COUNTED, support] } },
  ];
  for (const extra of forms) {
    const { handler } = load(t, { budgets: [budget('charge types', 25, extra)] });
    assert.equal(answer(await ask(handler)).limit.name, 'charge types', JSON.stringify(extra));
  }
});

test('what the figure counts follows the budget\'s charge-type filter, in either form', async (t) => {
  captureConsole(t);
  at(t, NOW);
  const not = (value) => ({ Not: { Dimensions: { Key: 'RECORD_TYPE', Values: [value] } } });
  const forms = [
    [{ FilterExpression: NOT_COUNTED }, 'pre-credit-pre-tax'],
    [{ FilterExpression: { And: [not('Credit'), not('Refund'), not('Tax')] } }, 'pre-credit-pre-tax'],
    [{}, 'net'],
    [{ FilterExpression: not('Credit') }, 'unknown'],
    [{ CostTypes: { IncludeCredit: false, IncludeRefund: false, IncludeTax: false } }, 'pre-credit-pre-tax'],
    [{ CostTypes: { IncludeCredit: true, IncludeRefund: true, IncludeTax: true } }, 'net'],
    [{ CostTypes: { IncludeCredit: false } }, 'unknown'],
  ];
  for (const [extra, basis] of forms) {
    const { handler } = load(t, { budgets: [budget('charge types', 25, extra)] });
    assert.equal(answer(await ask(handler)).spent.basis, basis, JSON.stringify(extra));
  }
});

test('a budget AWS has not calculated yet has a limit but no amount, and says why', async (t) => {
  captureConsole(t);
  at(t, NOW);
  const { handler } = load(t, { budgets: [budget(OURS, 20, { CalculatedSpend: undefined })] });

  const shown = answer(await ask(handler));

  assert.equal(shown.spent.amount, null);
  assert.equal(shown.spent.source, 'budget');
  assert.equal(shown.limit.amount, 20);
  assert.deepEqual(shown.notices, [NOTICE.notCalculated]);
});

test('NotFoundException from Budgets means no budgets', async (t) => {
  captureConsole(t);
  at(t, NOW);
  const fn = load(t, { describe: () => { throw awsError('NotFoundException', 'no budgets'); } });

  const res = await ask(fn.handler);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(answer(res).notices, [NOTICE.noBudget]);
});

test('the log lists every budget AWS showed, masked, so the first deploy shows what an account lists', async (t) => {
  const logs = captureConsole(t);
  at(t, NOW);
  const { handler } = load(t, { budgets: [budget(`${ACCOUNT}-limit`, 20), budget('daily', 5, { TimeUnit: 'DAILY' })] });

  await ask(handler);

  const line = logs.find((text) => text.startsWith('budgets listed '));
  assert.ok(line, logs.join('\n'));
  for (const text of logs) assert.ok(!text.includes(ACCOUNT), text);
  assert.deepEqual(JSON.parse(line.slice('budgets listed '.length)), [
    {
      name: '[account]-limit', type: 'COST', unit: 'MONTHLY', amount: 20, qualifies: true,
    },
    {
      name: 'daily', type: 'COST', unit: 'DAILY', amount: 5, qualifies: false,
    },
  ]);
});

test('no budget and Cost Explorer off: no spend, a notice, and nothing asked that costs', async (t) => {
  captureConsole(t);
  at(t, NOW);
  const fn = load(t);

  const res = await ask(fn.handler);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(answer(res), {
    month: '2026-11',
    currency: 'USD',
    spent: {
      amount: null, source: 'none', basis: 'unknown', estimated: null, asOf: NOW, keptUntil: null,
    },
    limit: null,
    notices: [NOTICE.noBudget],
  });
  assert.deepEqual(fn.commands(), budgetCalls, 'no Cost Explorer and no SSM');
});

test('no budget and Cost Explorer on: a claim is written, then one request, and the reading is kept for a day', async (t) => {
  captureConsole(t);
  at(t, NOW);
  const fn = load(t, { env: CE_ON });

  const shown = answer(await ask(fn.handler));

  assert.deepEqual(fn.commands(),
    ['DescribeBudgetsCommand', 'GetParameterCommand', 'PutParameterCommand', 'GetCostAndUsageCommand', 'PutParameterCommand']);
  const [, , claim, request, keep] = fn.calls;
  assert.deepEqual({ ...claim.input, Value: JSON.parse(claim.input.Value) }, {
    Name: PARAMETER,
    Value: {
      month: '2026-11', pending: true, asOf: NOW, keptUntil: later(NOW, 10 * 60 * 1000),
    },
    Type: 'String',
    Overwrite: true,
  });
  assert.deepEqual(request.input, {
    TimePeriod: { Start: '2026-11-01', End: '2026-12-01' },
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
    Filter: NOT_COUNTED,
  });
  assert.equal(keep.input.Name, PARAMETER);
  assert.deepEqual(fn.kept(), {
    month: '2026-11', amount: 3.42, estimated: true, asOf: NOW, keptUntil: later(NOW, 24 * HOUR), notices: [],
  });
  assert.deepEqual(shown, {
    month: '2026-11',
    currency: 'USD',
    spent: {
      amount: 3.42,
      source: 'cost-explorer',
      basis: 'pre-credit-pre-tax',
      estimated: true,
      asOf: NOW,
      keptUntil: later(NOW, 24 * HOUR),
    },
    limit: null,
    notices: [],
  });
});

test('a current reading is served as it is, an expired one is asked again, and a fresh claim is waited for', async (t) => {
  captureConsole(t);
  at(t, NOW);
  const reading = (asOf, keptUntil, month = '2026-11') => JSON.stringify({
    month, amount: 7.5, estimated: false, asOf, keptUntil, notices: [],
  });

  const current = load(t, { env: CE_ON, kept: reading('2026-11-06T09:00:00.000Z', '2026-11-07T09:00:00.000Z') });
  const served = answer(await ask(current.handler));
  assert.deepEqual(current.commands(), ['DescribeBudgetsCommand', 'GetParameterCommand'], 'nothing paid, nothing written');
  assert.deepEqual(served.spent, {
    amount: 7.5,
    source: 'cost-explorer',
    basis: 'pre-credit-pre-tax',
    estimated: false,
    asOf: '2026-11-06T09:00:00.000Z',
    keptUntil: '2026-11-07T09:00:00.000Z',
  });

  const expired = load(t, { env: CE_ON, kept: reading('2026-11-05T09:00:00.000Z', '2026-11-06T09:00:00.000Z') });
  assert.equal(answer(await ask(expired.handler)).spent.amount, 3.42);
  assert.equal(expired.commands().filter((command) => command === 'GetCostAndUsageCommand').length, 1);

  const lastMonth = load(t, { env: CE_ON, kept: reading('2026-10-31T23:00:00.000Z', '2026-11-30T00:00:00.000Z', '2026-10') });
  assert.equal(answer(await ask(lastMonth.handler)).month, '2026-11');
  assert.equal(lastMonth.commands().filter((command) => command === 'GetCostAndUsageCommand').length, 1, 'a reading is for its month');

  const claim = JSON.stringify({
    month: '2026-11', pending: true, asOf: later(NOW, -2 * 60 * 1000), keptUntil: later(NOW, 8 * 60 * 1000),
  });
  const pending = load(t, { env: CE_ON, kept: claim });
  const waiting = answer(await ask(pending.handler));
  assert.deepEqual(pending.commands(), ['DescribeBudgetsCommand', 'GetParameterCommand']);
  assert.equal(waiting.spent.amount, null);
  assert.deepEqual(waiting.notices, [NOTICE.cePending]);
});

test('when SSM cannot be read or the claim cannot be written, Cost Explorer is not asked', async (t) => {
  captureConsole(t);
  at(t, NOW);
  const unreadable = load(t, { env: CE_ON, get: () => { throw awsError('AccessDeniedException', `arn:aws:iam::${ACCOUNT}:role/x`); } });
  const unwritable = load(t, { env: CE_ON, put: () => { throw awsError('ThrottlingException', 'Rate exceeded'); } });

  const read = await ask(unreadable.handler);
  const write = await ask(unwritable.handler);

  assert.deepEqual(unreadable.commands(), ['DescribeBudgetsCommand', 'GetParameterCommand']);
  assert.deepEqual(unwritable.commands(), ['DescribeBudgetsCommand', 'GetParameterCommand', 'PutParameterCommand']);
  assert.equal(read.statusCode, 200);
  assert.equal(write.statusCode, 200);
  assert.deepEqual(answer(read).notices, ['The kept Cost Explorer reading could not be read (AccessDeniedException), '
    + 'so Cost Explorer was not asked and nothing was charged.']);
  assert.deepEqual(answer(write).notices, ['The Cost Explorer request could not be recorded (ThrottlingException), '
    + 'so it was not made and nothing was charged.']);
  for (const res of [read, write]) {
    assert.equal(answer(res).spent.amount, null);
    assert.ok(!res.body.includes(ACCOUNT), res.body);
  }
});

test('a kept value that is not JSON is overwritten by a claim before anything is paid for', async (t) => {
  captureConsole(t);
  at(t, NOW);
  const fn = load(t, { env: CE_ON, kept: 'not json' });

  const shown = answer(await ask(fn.handler));

  assert.deepEqual(fn.commands(),
    ['DescribeBudgetsCommand', 'GetParameterCommand', 'PutParameterCommand', 'GetCostAndUsageCommand', 'PutParameterCommand']);
  assert.equal(JSON.parse(fn.calls[2].input.Value).pending, true);
  assert.equal(shown.spent.amount, 3.42);
});

test('zero, day-1 and "no data yet" are kept 3 hours; "not enabled" and other refusals a day, naming only the error', async (t) => {
  captureConsole(t);
  const cases = [
    {
      now: NOW,
      ce: () => ({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: '0', Unit: 'USD' } }, Estimated: true }] }),
      keep: 3 * HOUR,
      amount: 0,
      notices: [],
    },
    {
      now: NOW, ce: () => ({ ResultsByTime: [] }), keep: 3 * HOUR, amount: 0, notices: [],
    },
    {
      now: '2026-12-01T05:00:00.000Z', keep: 3 * HOUR, amount: 3.42, notices: [],
    },
    {
      now: NOW,
      ce: () => { throw awsError('DataUnavailableException', 'Data is not available.'); },
      keep: 3 * HOUR,
      amount: null,
      notices: [NOTICE.ceNoData],
    },
    {
      now: NOW,
      ce: () => { throw awsError('AccessDeniedException', 'User not enabled for cost explorer access'); },
      keep: 24 * HOUR,
      amount: null,
      notices: [NOTICE.ceOff],
    },
    {
      now: NOW,
      ce: () => { throw awsError('AccessDeniedException', `User: arn:aws:sts::${ACCOUNT}:assumed-role/x is not authorized`); },
      keep: 24 * HOUR,
      amount: null,
      notices: ['Cost Explorer refused the request (AccessDeniedException).'],
    },
    {
      now: NOW,
      ce: () => { throw awsError('BillExpirationException', `Bill for ${ACCOUNT} expired`); },
      keep: 24 * HOUR,
      amount: null,
      notices: ['Cost Explorer refused the request (BillExpirationException).'],
    },
  ];
  for (const { now, ce, keep, amount, notices } of cases) {
    t.mock.timers.reset();
    at(t, now);
    const fn = load(t, { env: CE_ON, ce });
    const res = await ask(fn.handler);
    const label = `${now} ${ce ? ce.toString().slice(0, 80) : 'a reading'}`;
    assert.equal(res.statusCode, 200, label);
    assert.equal(fn.kept().keptUntil, later(now, keep), label);
    assert.equal(answer(res).spent.amount, amount, label);
    assert.deepEqual(fn.kept().notices, notices, label);
    assert.ok(!res.body.includes(ACCOUNT) && !res.body.includes('expired') && !res.body.includes('not authorized'), res.body);
  }
});

test('Cost Explorer busy is kept 15 minutes and still answers 200, and the SDK never retries a paid request', async (t) => {
  captureConsole(t);
  const busy = [
    awsError('ThrottlingException', 'Rate exceeded'),
    awsError('LimitExceededException', 'Limit exceeded'),
    Object.assign(awsError('SomethingNew', 'AWS fault'), { $metadata: { httpStatusCode: 500 } }),
  ];
  for (const err of busy) {
    t.mock.timers.reset();
    at(t, NOW);
    const fn = load(t, { env: CE_ON, ce: () => { throw err; } });
    const res = await ask(fn.handler);
    assert.equal(res.statusCode, 200, err.name);
    assert.equal(fn.kept().keptUntil, later(NOW, 15 * 60 * 1000), err.name);
    assert.deepEqual(answer(res).notices, [`Cost Explorer was busy (${err.name}). The card asks again after 17:35 UTC.`]);
    assert.deepEqual(fn.configs.CostExplorerClient, { region: 'us-east-1', maxAttempts: 1 });
    assert.deepEqual(fn.configs.BudgetsClient, { region: 'us-east-1' });
  }
});

test('December rolls into January, and on the 1st the new-month notice joins any other', async (t) => {
  captureConsole(t);
  at(t, '2026-12-15T12:00:00.000Z');
  const december = load(t, { env: CE_ON });
  assert.equal(answer(await ask(december.handler)).month, '2026-12');
  assert.deepEqual(december.calls[3].input.TimePeriod, { Start: '2026-12-01', End: '2027-01-01' });

  t.mock.timers.reset();
  at(t, '2027-01-01T00:30:00.000Z');
  const january = load(t, { budgets: [budget(OURS, 20, { CalculatedSpend: undefined })] });
  const first = answer(await ask(january.handler));
  assert.equal(first.month, '2027-01');
  assert.deepEqual(first.notices, [NOTICE.notCalculated, NOTICE.newMonth]);

  const ceFirst = load(t, { env: CE_ON });
  const shown = answer(await ask(ceFirst.handler));
  assert.deepEqual(ceFirst.calls[3].input.TimePeriod, { Start: '2027-01-01', End: '2027-02-01' }, 'never an empty range on the 1st');
  assert.deepEqual(shown.notices, [NOTICE.newMonth]);
  assert.deepEqual(ceFirst.kept().notices, [], 'the new-month notice is added on each answer, not kept');

  t.mock.timers.setTime(Date.parse('2027-01-02T00:00:00.000Z'));
  assert.deepEqual(answer(await ask(january.handler)).notices, [NOTICE.notCalculated], 'from the 2nd, no new-month notice');
});

test('Budgets errors: denied is 502 budgets-denied, busy is 503 aws-busy, anything else 502 budgets-error', async (t) => {
  captureConsole(t);
  at(t, NOW);
  const quoting = `User: arn:aws:sts::${ACCOUNT}:assumed-role/r/s is not authorized`;
  const cases = [
    [awsError('AccessDeniedException', quoting), 502, 'budgets-denied',
      'AWS refused to show budgets to aws-spend (AccessDeniedException). Check AwsSpendRole: '
        + 'budgets:ViewBudget, and aws-portal:ViewBilling in older accounts.'],
    [awsError('InternalErrorException', quoting), 503, 'aws-busy',
      'AWS Budgets is busy (InternalErrorException). Reload the page in a minute.'],
    [awsError('ThrottlingException', quoting), 503, 'aws-busy',
      'AWS Budgets is busy (ThrottlingException). Reload the page in a minute.'],
    [Object.assign(awsError('SomethingNew', quoting), { $metadata: { httpStatusCode: 503 } }), 503, 'aws-busy',
      'AWS Budgets is busy (SomethingNew). Reload the page in a minute.'],
    [awsError('InvalidParameterException', quoting), 502, 'budgets-error',
      'AWS Budgets refused the request (InvalidParameterException). See the cloud-agentic-iot-aws-spend log.'],
  ];
  for (const [err, status, reason, error] of cases) {
    const fn = load(t, { env: CE_ON, describe: () => { throw err; } });
    const res = await ask(fn.handler);
    assert.equal(res.statusCode, status, err.name);
    assert.deepEqual(answer(res), { error, reason });
    assert.ok(error.length <= 200, 'Salesforce shows 200 characters');
    assert.ok(!res.body.includes('not authorized') && !res.body.includes(ACCOUNT), res.body);
    assert.deepEqual(fn.commands(), budgetCalls, 'nothing else is asked');
  }
});

test('no answer ever holds the AWS account ID', async (t) => {
  captureConsole(t);
  at(t, NOW);
  const named = load(t, { budgets: [budget(`${ACCOUNT}-monthly`, 20)], env: { SPEND_LIMIT_BUDGET_NAME: `${ACCOUNT}-monthly` } });
  const largest = load(t, { budgets: [budget(`alerts-${ACCOUNT}`, 30)] });
  const refused = load(t, { describe: () => { throw awsError('AccessDeniedException', `arn:aws:sts::${ACCOUNT}:assumed-role/r/s`); } });
  const ceRefused = load(t, { env: CE_ON, ce: () => { throw awsError('ValidationException', `account ${ACCOUNT}`); } });

  const responses = [];
  for (const fn of [named, largest, refused, ceRefused]) responses.push(await ask(fn.handler));

  assert.equal(answer(responses[0]).limit.name, '[account]-monthly');
  assert.equal(answer(responses[1]).limit.name, 'alerts-[account]');
  for (const res of responses) assert.ok(!res.body.includes(ACCOUNT), res.body);
});

test('anything but an empty JSON object is refused before any AWS call', async (t) => {
  captureConsole(t);
  const fn = load(t, { env: CE_ON });
  const requests = [
    { body: JSON.stringify({ month: '2026-10' }) }, { body: '[]' }, { body: 'nope' }, { body: 'null' }, { body: '"{}"' },
  ];

  for (const request of requests) {
    const res = await fn.handler(request);
    assert.equal(res.statusCode, 400, request.body);
    assert.equal(answer(res).reason, 'bad-request', request.body);
  }
  assert.deepEqual(answer(await fn.handler({ body: JSON.stringify({ month: '2026-10' }) })),
    { error: 'POST /aws-spend takes an empty JSON object: {}', reason: 'bad-request' });
  assert.equal(fn.calls.length, 0);
});

test('a missing or malformed setting is 500 misconfigured, naming it, before any AWS call', async (t) => {
  captureConsole(t);
  const broken = [
    ['ACCOUNT_ID', undefined],
    ['SPEND_CACHE_PARAMETER', undefined],
    ['SPEND_CACHE_HOURS', undefined],
    ['SPEND_CACHE_HOURS', 'a day'],
    ['SPEND_CACHE_HOURS', '0'],
    ['SPEND_COST_EXPLORER', undefined],
  ];
  for (const [name, value] of broken) {
    const fn = load(t, { env: { [name]: value } });
    const res = await ask(fn.handler);
    assert.equal(res.statusCode, 500, `${name}=${value}`);
    const body = answer(res);
    assert.equal(body.reason, 'misconfigured');
    assert.match(body.error, new RegExp(`^aws-spend is missing a setting \\(${name} `));
    assert.ok(body.error.length <= 200, body.error);
    assert.equal(fn.calls.length, 0, name);
  }
});
