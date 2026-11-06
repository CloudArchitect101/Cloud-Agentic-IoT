'use strict';

/*
 * Test doubles for the Lambda handlers.
 *
 * The AWS SDK is not installed in this repo - the Lambda runtime provides it -
 * so every package a handler requires is replaced by a fake at load time.
 * Nothing here talks to AWS or Salesforce.
 */

const Module = require('node:module');

const path = require('node:path');

// lambda/shared is copied into each function's node_modules as
// @cloud-agentic-iot/shared when it is packaged (scripts/deploy-aws.sh). In
// the repo it is a plain directory, so tests resolve the package name to it.
const SHARED_PACKAGE = '@cloud-agentic-iot/shared';
const SHARED_DIR = path.join(__dirname, '../../lambda/shared');

/**
 * Loads a fresh copy of a handler with the named packages replaced by fakes.
 * Fresh on every call, so module-level state (SDK clients, caches, environment
 * variables read at load time) never leaks from one test into the next. That
 * includes the shared modules, which hold the Salesforce token and SSM caches.
 */
function loadWithFakes(modulePath, fakes = {}) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  for (const cached of Object.keys(require.cache)) {
    if (cached.startsWith(SHARED_DIR + path.sep)) delete require.cache[cached];
  }

  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (Object.hasOwn(fakes, request)) return fakes[request];
    if (request === SHARED_PACKAGE || request.startsWith(`${SHARED_PACKAGE}/`)) {
      const target = path.join(SHARED_DIR, request.slice(SHARED_PACKAGE.length) || 'index');
      return originalLoad.call(this, target, ...rest);
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require(resolved);
  } finally {
    Module._load = originalLoad;
  }
}

/**
 * A fake SSM holding the given parameters by name. Records every read, so a
 * test can see that a value was cached rather than read again.
 */
function fakeSsm(parameters = {}) {
  const { sdk, calls } = fakeAwsSdk('SSMClient', ['GetParameterCommand'], (command, input) => {
    if (!Object.hasOwn(parameters, input.Name)) {
      throw awsError('ParameterNotFound', `Parameter ${input.Name} not found.`);
    }
    return { Parameter: { Name: input.Name, Value: parameters[input.Name] } };
  });
  return { sdk, calls, parameters };
}

/**
 * A fake AWS SDK v3 package: one client whose send() records every command,
 * plus a class for each command name. `respond(commandName, input)` decides
 * what a command returns; throwing from it simulates an AWS error.
 */
function fakeAwsSdk(clientName, commandNames, respond = () => ({})) {
  const calls = [];
  const sdk = {
    [clientName]: class {
      async send(command) {
        const call = { command: command.constructor.name, input: command.input };
        calls.push(call);
        return respond(call.command, call.input);
      }
    },
  };
  for (const name of commandNames) {
    // Computed key so the class's .name is the command name.
    sdk[name] = { [name]: class { constructor(input) { this.input = input; } } }[name];
  }
  return { sdk, calls };
}

/**
 * A fake DynamoDB table behind the document client (@aws-sdk/lib-dynamodb),
 * holding `items` and enforcing what the real service would reject: more than
 * 100 keys in a BatchGetItem or 25 items in a BatchWriteItem, the same key
 * twice in one request, an UpdateItem whose ConditionExpression fails, and
 * an UpdateItem that uses a placeholder with no (or an undefined) value.
 * GetItem and Query read the same items; a Query returns them in sort key
 * order, reversed by ScanIndexForward false, and stops at Limit.
 *
 * options.unprocessed(commandName, entries) returns the keys or write
 * requests to leave unprocessed this time, as DynamoDB does when throttled.
 * options.beforeUpdate(table, input) runs before an update is applied, so a
 * test can change the item underneath it. options.fail(commandName, input)
 * may throw, to fail that call as DynamoDB does when it refuses or is
 * unreachable.
 */
function fakeDynamoDb(items = [], { unprocessed = () => [], beforeUpdate = () => {}, fail = () => {} } = {}) {
  const keyOf = (item) => `${item.PK}|${item.SK}`;
  const table = new Map(items.map((item) => [keyOf(item), structuredClone(item)]));
  const calls = [];
  const sdk = {
    DynamoDBDocumentClient: {
      from: () => ({ send: async (command) => respond(command.constructor.name, command.input) }),
    },
  };
  for (const name of ['BatchGetCommand', 'BatchWriteCommand', 'UpdateCommand', 'GetCommand', 'QueryCommand']) {
    sdk[name] = { [name]: class { constructor(input) { this.input = input; } } }[name];
  }

  function assertDistinct(keys) {
    if (new Set(keys).size !== keys.length) {
      throw awsError('ValidationException', 'Provided list of item keys contains duplicates');
    }
  }

  function respond(command, input) {
    calls.push({ command, input });
    fail(command, input);
    if (command === 'BatchGetCommand') {
      const [[name, { Keys }]] = Object.entries(input.RequestItems);
      if (Keys.length > 100) throw awsError('ValidationException', 'Too many items requested for the BatchGetItem call');
      assertDistinct(Keys.map(keyOf));
      const skipped = new Set(unprocessed(command, Keys));
      const found = Keys.filter((key) => !skipped.has(key)).map((key) => table.get(keyOf(key))).filter(Boolean);
      return {
        Responses: { [name]: found.map((item) => structuredClone(item)) },
        UnprocessedKeys: skipped.size ? { [name]: { Keys: [...skipped] } } : {},
      };
    }
    if (command === 'BatchWriteCommand') {
      const [[name, requests]] = Object.entries(input.RequestItems);
      if (requests.length > 25) throw awsError('ValidationException', 'Too many items in the BatchWriteItem call');
      assertDistinct(requests.map((request) => keyOf(request.PutRequest.Item)));
      const skipped = new Set(unprocessed(command, requests));
      for (const request of requests) {
        if (!skipped.has(request)) table.set(keyOf(request.PutRequest.Item), structuredClone(request.PutRequest.Item));
      }
      return { UnprocessedItems: skipped.size ? { [name]: [...skipped] } : {} };
    }
    if (command === 'UpdateCommand') {
      beforeUpdate(table, input);
      const current = table.get(keyOf(input.Key));
      const values = input.ExpressionAttributeValues || {};
      assertValuesDefined(values, input.UpdateExpression, input.ConditionExpression);
      if (input.ConditionExpression && !conditionHolds(input.ConditionExpression, current, values)) {
        throw awsError('ConditionalCheckFailedException', 'The conditional request failed');
      }
      const next = { ...(current || input.Key) };
      for (const assignment of input.UpdateExpression.replace(/^SET\s+/, '').split(',')) {
        const [attribute, placeholder] = assignment.split('=').map((part) => part.trim());
        next[attribute] = values[placeholder];
      }
      table.set(keyOf(input.Key), next);
      return {};
    }
    if (command === 'GetCommand') {
      const item = table.get(keyOf(input.Key));
      return item ? { Item: structuredClone(item) } : {};
    }
    if (command === 'QueryCommand') {
      const { partition, prefix } = keyCondition(input.KeyConditionExpression, input.ExpressionAttributeValues || {});
      const found = [...table.values()]
        .filter((item) => item.PK === partition && (prefix === undefined || item.SK.startsWith(prefix)))
        .sort((a, b) => (a.SK < b.SK ? -1 : Number(a.SK > b.SK)));
      if (input.ScanIndexForward === false) found.reverse();
      const page = found.slice(0, input.Limit ?? found.length);
      const last = page.length < found.length ? page.at(-1) : null;
      return {
        Items: page.map((item) => structuredClone(item)),
        Count: page.length,
        ScannedCount: page.length,
        ...(last ? { LastEvaluatedKey: { PK: last.PK, SK: last.SK } } : {}),
      };
    }
    throw new Error(`fakeDynamoDb does not implement ${command}`);
  }

  return {
    sdk,
    table,
    calls,
    count: (command) => calls.filter((call) => call.command === command).length,
  };
}

/**
 * Like DynamoDB, refuses an update whose expressions use a placeholder with
 * no value. An undefined value counts as missing: the document client's
 * removeUndefinedValues drops it before the request is sent.
 */
function assertValuesDefined(values, ...expressions) {
  const used = expressions.filter(Boolean).flatMap((expression) => String(expression).match(/:\w+/g) || []);
  const missing = used.find((placeholder) => !Object.hasOwn(values, placeholder) || values[placeholder] === undefined);
  if (missing) {
    throw awsError('ValidationException', `An expression attribute value used in expression is not defined; attribute value: ${missing}`);
  }
}

/**
 * The key conditions the handlers query with: the partition key equal to a
 * placeholder, optionally AND begins_with(SK, placeholder). Anything else
 * throws, as in conditionHolds below. Like DynamoDB, it refuses a
 * placeholder with no value and a value no placeholder uses.
 */
function keyCondition(expression, values) {
  const match = String(expression).match(/^PK\s*=\s*(:\w+)(?:\s+AND\s+begins_with\(\s*SK\s*,\s*(:\w+)\s*\))?$/);
  if (!match) throw new Error(`fakeDynamoDb cannot evaluate the key condition "${expression}"`);
  const used = match.slice(1).filter(Boolean);
  const undefinedValue = used.find((placeholder) => !Object.hasOwn(values, placeholder));
  if (undefinedValue) {
    throw awsError('ValidationException', `An expression attribute value used in expression is not defined; attribute value: ${undefinedValue}`);
  }
  const unused = Object.keys(values).filter((placeholder) => !used.includes(placeholder));
  if (unused.length) {
    throw awsError('ValidationException', `Value provided in ExpressionAttributeValues unused in expressions: keys: {${unused.join(', ')}}`);
  }
  return { partition: values[match[1]], prefix: match[2] && values[match[2]] };
}

/**
 * The part of DynamoDB's condition language the handlers use: clauses joined
 * by OR, each attribute_exists(a), attribute_not_exists(a), or a comparison
 * of an attribute with a placeholder. Anything else throws, so a handler
 * cannot pass a test with a condition the fake silently misread.
 */
function conditionHolds(expression, item, values) {
  return expression.split(/\s+OR\s+/).some((clause) => {
    const exists = clause.match(/^attribute_(not_)?exists\((\w+)\)$/);
    if (exists) {
      const present = item !== undefined && item[exists[2]] !== undefined;
      return exists[1] ? !present : present;
    }
    const comparison = clause.match(/^(\w+)\s*(<=|>=|<>|<|>|=)\s*(:\w+)$/);
    if (!comparison) throw new Error(`fakeDynamoDb cannot evaluate "${clause}"`);
    if (item === undefined || item[comparison[1]] === undefined) return false;
    const [left, right] = [item[comparison[1]], values[comparison[3]]];
    switch (comparison[2]) {
      case '<': return left < right;
      case '<=': return left <= right;
      case '>': return left > right;
      case '>=': return left >= right;
      case '=': return left === right;
      default: return left !== right;
    }
  });
}

/**
 * A fake SQS for SendMessageBatch with the service's own limits: at most 10
 * entries, with distinct ids. options.reject(entry) returns an error code for
 * an entry SQS should report under Failed; options.outage(input) makes the
 * whole call throw. Accepted messages are kept, parsed, in `messages`.
 */
function fakeSqs({ reject = () => null, outage = () => false } = {}) {
  const messages = [];
  const { sdk, calls } = fakeAwsSdk('SQSClient', ['SendMessageBatchCommand'], (command, input) => {
    if (outage(input)) throw awsError('ServiceUnavailable', 'Service is unavailable. Try again later.');
    const { Entries } = input;
    if (Entries.length > 10) throw awsError('TooManyEntriesInBatchRequest', `${Entries.length} entries; the limit is 10`);
    if (new Set(Entries.map((entry) => entry.Id)).size !== Entries.length) {
      throw awsError('BatchEntryIdsNotDistinct', 'Two entries share an id');
    }
    const Successful = [];
    const Failed = [];
    for (const entry of Entries) {
      const code = reject(entry);
      if (code) {
        Failed.push({ Id: entry.Id, Code: code, SenderFault: false, Message: code });
      } else {
        messages.push({ queueUrl: input.QueueUrl, body: JSON.parse(entry.MessageBody) });
        Successful.push({ Id: entry.Id, MessageId: `sqs-${messages.length}` });
      }
    }
    return { Successful, Failed };
  });
  return { sdk, calls, messages };
}

/** An AWS-style error, matched by handlers on err.name. */
function awsError(name, message = name) {
  const err = new Error(message);
  err.name = name;
  return err;
}

/**
 * Replaces global fetch for the duration of one test. `respond(request)`
 * returns a Response; the recorded requests are returned for assertions.
 */
function fakeFetch(t, respond) {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const request = {
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body,
    };
    requests.push(request);
    return respond(request);
  };
  t.after(() => { globalThis.fetch = original; });
  return requests;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Silences the handlers' logging for one test and returns the captured lines,
 * so a test can also assert on what was (or was not) logged.
 */
function captureConsole(t) {
  const lines = [];
  for (const level of ['log', 'info', 'warn', 'error']) {
    t.mock.method(console, level, (...args) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
  return lines;
}

/** Sets environment variables for one test and restores them afterwards. */
function withEnv(t, vars) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

module.exports = {
  loadWithFakes,
  fakeSsm,
  fakeDynamoDb,
  fakeSqs,
  fakeAwsSdk,
  awsError,
  fakeFetch,
  jsonResponse,
  captureConsole,
  withEnv,
};
