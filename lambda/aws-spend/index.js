'use strict';

const { BudgetsClient, DescribeBudgetsCommand } = require('@aws-sdk/client-budgets');
const { CostExplorerClient, GetCostAndUsageCommand } = require('@aws-sdk/client-cost-explorer');
const { SSMClient, GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');
const { BadRequest, parseBody, respond, isTransient } = require('@cloud-agentic-iot/shared/api');
const { requiredEnv, numberEnv } = require('@cloud-agentic-iot/shared/env');

// Budgets and Cost Explorer answer in us-east-1 only, whichever Region this runs in.
const budgets = new BudgetsClient({ region: 'us-east-1' });
// Each Cost Explorer request costs $0.01, so the SDK must never retry one on its own.
const costExplorer = new CostExplorerClient({ region: 'us-east-1', maxAttempts: 1 });
const ssm = new SSMClient({});

// What a project's spend limit leaves out, and so what this leaves out too.
const NOT_COUNTED = ['Credit', 'Refund', 'Tax'];
// Budgets this small are alerts (for example AWS's zero-spend template), never a limit.
const MIN_LIMIT_USD = 1;
// "Try again later" errors that AWS sends as HTTP 400, which the shared isTransient cannot tell from a refusal.
const BUSY = new Set(['InternalErrorException', 'LimitExceededException']);

const HOUR = 60 * 60 * 1000;
const SHORT_KEEP = 3 * HOUR;         // zero reads, day-1 reads, "no data yet"
const PENDING_KEEP = 10 * 60 * 1000; // a claim another page load is working on
const BUSY_KEEP = 15 * 60 * 1000;    // Cost Explorer was busy

const NOTICE = {
  notCalculated: "AWS has not calculated this budget's spend yet. It recalculates budgets about every 8 to 12 hours.",
  newMonth: 'A new month began at 00:00 UTC. AWS can take up to a day to show this month\'s spend, '
    + 'and a budget may show a stale figure until it recalculates.',
  noBudget: 'No monthly cost budget found, so there is no spend to show. Create the budget cloud-agentic-iot-monthly, '
    + "which AWS lists no charge for reading. In an AWS project, set its amount to the project's spend limit.",
  ceOff: 'Cost Explorer is not enabled in this account. Create the budget cloud-agentic-iot-monthly instead; '
    + 'the card reads budgets at no charge.',
  ceNoData: 'Cost Explorer has no data for this month yet.',
  cePending: 'Cost Explorer is being asked right now. Reload the page in a minute.',
};

/**
 * This month's AWS spend and its limit, for the usage card on the Cloud
 * Agentic IoT Home page in Salesforce. See docs/SPEND-AND-LIMITS.md.
 *
 * Both numbers come from one AWS budget: the one named SPEND_LIMIT_BUDGET_NAME
 * when it exists, else the largest monthly cost budget over $1 that counts
 * every service. In an AWS project that named budget mirrors the spend limit,
 * which no API returns. AWS lists no charge for reading budgets, so they are
 * read on every page load.
 *
 * With no budget, spend comes from Cost Explorer only when SPEND_COST_EXPLORER
 * is "true". It costs $0.01 a request, so a request is made only after a claim
 * on the cache parameter was written: if SSM fails, nothing is paid for.
 *
 * The answer never holds the account ID, which the card must not show.
 */
exports.handler = async (event) => {
  let body;
  try {
    body = parseBody(event);
  } catch (err) {
    if (err instanceof BadRequest) return respond(400, { error: err.message, reason: 'bad-request' });
    throw err;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0) {
    return respond(400, { error: 'POST /aws-spend takes an empty JSON object: {}', reason: 'bad-request' });
  }

  let settings;
  try {
    settings = {
      accountId: requiredEnv('ACCOUNT_ID'),
      cacheParameter: requiredEnv('SPEND_CACHE_PARAMETER'),
      keepMillis: numberEnv('SPEND_CACHE_HOURS') * HOUR,
      costExplorer: requiredEnv('SPEND_COST_EXPLORER') === 'true',
      preferredName: process.env.SPEND_LIMIT_BUDGET_NAME || '',
    };
  } catch (err) {
    return respond(500, {
      error: `aws-spend is missing a setting (${err.message}). Deploy the current queue-relay stack.`.slice(0, 200),
      reason: 'misconfigured',
    });
  }

  const now = new Date();
  const month = now.toISOString().slice(0, 7); // "2026-11": AWS bills by the UTC month

  let answer;
  try {
    const chosen = chooseBudget(await listBudgets(settings.accountId), settings.preferredName);
    if (chosen) answer = fromBudget(chosen, month, now);
    else if (settings.costExplorer) answer = await fromCostExplorer(month, now, settings);
    else answer = nothingToShow(month, now);
  } catch (err) {
    console.error('Could not read AWS budgets', { name: err.name });
    // The error's name only: its message can quote an ARN, and in it the account ID.
    if (busy(err)) return respond(503, { error: `AWS Budgets is busy (${err.name}). Reload the page in a minute.`, reason: 'aws-busy' });
    if (err.name === 'AccessDeniedException') {
      return respond(502, {
        error: 'AWS refused to show budgets to aws-spend (AccessDeniedException). Check AwsSpendRole: '
          + 'budgets:ViewBudget, and aws-portal:ViewBilling in older accounts.',
        reason: 'budgets-denied',
      });
    }
    return respond(502, { error: `AWS Budgets refused the request (${err.name}). See the cloud-agentic-iot-aws-spend log.`, reason: 'budgets-error' });
  }
  if (now.getUTCDate() === 1) answer.notices.push(NOTICE.newMonth);

  console.log('aws spend', { source: answer.spent.source, amount: answer.spent.amount !== null, limit: answer.limit !== null });
  return respond(200, answer);
};

function busy(err) {
  return isTransient(err) || BUSY.has(err.name);
}

/** The account's budgets. NotFoundException is how Budgets may say "none". */
async function listBudgets(accountId) {
  try {
    const { Budgets = [] } = await budgets.send(new DescribeBudgetsCommand({
      AccountId: accountId, MaxResults: 100, ShowFilterExpression: true,
    }));
    return Budgets;
  } catch (err) {
    if (err.name === 'NotFoundException') return [];
    throw err;
  }
}

/** The named budget if it qualifies, else the largest qualifying one over $1, else null. */
function chooseBudget(list, preferredName) {
  console.log('budgets listed', list.map((b) => ({
    name: withoutAccountIds(b.BudgetName),
    type: b.BudgetType,
    unit: b.TimeUnit,
    amount: b.BudgetLimit ? Number(b.BudgetLimit.Amount) : null,
    qualifies: qualifies(b),
  })));
  const candidates = list.filter(qualifies);
  const named = preferredName && candidates.find((b) => b.BudgetName === preferredName);
  if (named) return { budget: named, chosenBy: 'name' };
  const largest = candidates
    .filter((b) => Number(b.BudgetLimit.Amount) > MIN_LIMIT_USD)
    .sort((a, b) => Number(b.BudgetLimit.Amount) - Number(a.BudgetLimit.Amount) || a.BudgetName.localeCompare(b.BudgetName))[0];
  return largest ? { budget: largest, chosenBy: 'largest' } : null;
}

/** A monthly cost budget in USD that counts every service. */
function qualifies(budget) {
  return budget.BudgetType === 'COST'
    && budget.TimeUnit === 'MONTHLY'
    && Boolean(budget.BudgetLimit) && budget.BudgetLimit.Unit === 'USD'
    && Number.isFinite(Number(budget.BudgetLimit.Amount))
    && (budget.FilterExpression
      ? onlyChargeTypes(budget.FilterExpression)
      : Object.keys(budget.CostFilters || {}).length === 0);
}

/**
 * True for no filter, or one on charge type alone (credits, refunds, tax):
 * that changes what is counted, not which services.
 */
function onlyChargeTypes(expression) {
  if (!expression) return true;
  const { And = [], Or = [], Not, Dimensions, Tags, CostCategories, ProductAttributes } = expression;
  if (Tags || CostCategories || ProductAttributes) return false;
  if (Dimensions && Dimensions.Key !== 'RECORD_TYPE') return false;
  return onlyChargeTypes(Not) && [...And, ...Or].every(onlyChargeTypes);
}

/** Whether the budget counts the way a spend limit does: before credits, refunds and tax. */
function basisOf(budget) {
  if (!budget.FilterExpression) {
    const types = budget.CostTypes || {};
    const excluded = [types.IncludeCredit, types.IncludeRefund, types.IncludeTax].filter((v) => v === false).length;
    if (excluded === 3) return 'pre-credit-pre-tax';
    return excluded === 0 ? 'net' : 'unknown';
  }
  const left = new Set();
  for (const term of budget.FilterExpression.And || [budget.FilterExpression]) {
    const dims = term.Not && term.Not.Dimensions;
    if (dims && dims.Key === 'RECORD_TYPE') (dims.Values || []).forEach((v) => left.add(v));
  }
  return NOT_COUNTED.every((v) => left.has(v)) ? 'pre-credit-pre-tax' : 'unknown';
}

function fromBudget({ budget, chosenBy }, month, now) {
  const actual = budget.CalculatedSpend && budget.CalculatedSpend.ActualSpend;
  return {
    month,
    currency: 'USD',
    spent: {
      amount: actual ? cents(actual.Amount) : null, source: 'budget', basis: basisOf(budget),
      estimated: null, asOf: now.toISOString(), keptUntil: null,
    },
    limit: { amount: cents(budget.BudgetLimit.Amount), source: 'budget', name: withoutAccountIds(budget.BudgetName), chosenBy },
    notices: actual ? [] : [NOTICE.notCalculated],
  };
}

function nothingToShow(month, now, notice = NOTICE.noBudget) {
  return {
    month,
    currency: 'USD',
    spent: { amount: null, source: 'none', basis: 'unknown', estimated: null, asOf: now.toISOString(), keptUntil: null },
    limit: null,
    notices: [notice],
  };
}

/**
 * The month's spend from Cost Explorer. A paid request is made only when no
 * kept reading is current AND a claim was written first, so an SSM failure
 * can never turn every page load into a paid request.
 */
async function fromCostExplorer(month, now, settings) {
  let kept;
  try {
    kept = await readKept(settings.cacheParameter);
  } catch (err) {
    return nothingToShow(month, now, `The kept Cost Explorer reading could not be read (${err.name}), so Cost Explorer was not asked and nothing was charged.`);
  }
  if (kept && kept.month === month && now.getTime() < Date.parse(kept.keptUntil)) {
    return kept.pending ? nothingToShow(month, now, NOTICE.cePending) : fromReading(kept);
  }

  const claim = { month, pending: true, asOf: now.toISOString(), keptUntil: new Date(now.getTime() + PENDING_KEEP).toISOString() };
  try {
    await write(settings.cacheParameter, claim);
  } catch (err) {
    console.error('Could not write the Cost Explorer claim', { name: err.name });
    return nothingToShow(month, now, `The Cost Explorer request could not be recorded (${err.name}), so it was not made and nothing was charged.`);
  }

  const reading = await askCostExplorer(month, now, settings.keepMillis);
  try {
    await write(settings.cacheParameter, reading);
  } catch (err) {
    // The claim still holds for 10 minutes, so this costs at most one request per 10 minutes.
    console.warn('Could not keep the Cost Explorer reading', { name: err.name });
  }
  return fromReading(reading);
}

async function askCostExplorer(month, now, keepMillis) {
  const until = (millis) => new Date(now.getTime() + millis).toISOString();
  try {
    const { ResultsByTime = [] } = await costExplorer.send(new GetCostAndUsageCommand({
      // Start is inclusive and End exclusive. Ending on the 1st of next month,
      // never today, keeps the range a whole month even on the 1st.
      TimePeriod: { Start: `${month}-01`, End: firstOfNextMonth(month) },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      Filter: { Not: { Dimensions: { Key: 'RECORD_TYPE', Values: NOT_COUNTED } } },
    }));
    const first = ResultsByTime[0] || {};
    const total = first.Total && first.Total.UnblendedCost;
    const amount = total ? cents(total.Amount) : 0;
    // A zero, or anything read on the 1st, is likely to change within hours.
    const short = amount === 0 || now.getUTCDate() === 1;
    return { month, amount, estimated: first.Estimated === true, asOf: now.toISOString(),
      keptUntil: until(short ? Math.min(SHORT_KEEP, keepMillis) : keepMillis), notices: [] };
  } catch (err) {
    console.error('Cost Explorer did not answer', { name: err.name });
    const failed = (notice, millis) => ({ month, amount: null, estimated: null, asOf: now.toISOString(), keptUntil: until(millis), notices: [notice] });
    if (busy(err)) {
      const retry = until(BUSY_KEEP).slice(11, 16);
      return failed(`Cost Explorer was busy (${err.name}). The card asks again after ${retry} UTC.`, BUSY_KEEP);
    }
    if (err.name === 'DataUnavailableException') return failed(NOTICE.ceNoData, Math.min(SHORT_KEEP, keepMillis));
    // AWS's own words when no one has enabled Cost Explorer in this account.
    if (err.name === 'AccessDeniedException' && /not enabled for cost explorer/i.test(err.message)) return failed(NOTICE.ceOff, keepMillis);
    return failed(`Cost Explorer refused the request (${err.name}).`, keepMillis);
  }
}

function fromReading(reading) {
  return {
    month: reading.month,
    currency: 'USD',
    spent: {
      amount: reading.amount, source: 'cost-explorer', basis: 'pre-credit-pre-tax',
      estimated: reading.estimated, asOf: reading.asOf, keptUntil: reading.keptUntil,
    },
    limit: null,
    notices: [...(reading.notices || [])],
  };
}

/** The kept reading or claim; null when there is none ("{}" or a value that is not JSON). Throws on SSM errors. */
async function readKept(name) {
  let value;
  try {
    ({ Parameter: { Value: value } } = await ssm.send(new GetParameterCommand({ Name: name })));
  } catch (err) {
    if (err.name === 'ParameterNotFound') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && parsed.month ? parsed : null;
  } catch {
    return null; // a corrupt value is overwritten by the claim before anything is paid for
  }
}

async function write(name, value) {
  await ssm.send(new PutParameterCommand({ Name: name, Value: JSON.stringify(value), Type: 'String', Overwrite: true }));
}

/** Dollars, to the cent; null for anything that is not a number. */
function cents(amount) {
  const value = Number(amount);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

/** "2026-12" -> "2027-01-01". Date.UTC counts months from 0, so the 1-based month is already the next one. */
function firstOfNextMonth(month) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 10);
}

/** A budget name can hold an account ID; the card must never show one. */
function withoutAccountIds(text) {
  return String(text).replace(/[0-9]{12}/g, '[account]');
}
