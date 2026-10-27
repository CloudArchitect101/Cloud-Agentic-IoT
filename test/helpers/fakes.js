'use strict';

/*
 * Test doubles for the Lambda handlers.
 *
 * The AWS SDK is not installed in this repo - the Lambda runtime provides it -
 * so every package a handler requires is replaced by a fake at load time.
 * Nothing here talks to AWS or Salesforce.
 */

const Module = require('node:module');

/**
 * Loads a fresh copy of a handler with the named packages replaced by fakes.
 * Fresh on every call, so module-level state (SDK clients, caches, environment
 * variables read at load time) never leaks from one test into the next.
 */
function loadWithFakes(modulePath, fakes = {}) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];

  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (Object.hasOwn(fakes, request)) return fakes[request];
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require(resolved);
  } finally {
    Module._load = originalLoad;
  }
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
  fakeAwsSdk,
  awsError,
  fakeFetch,
  jsonResponse,
  captureConsole,
  withEnv,
};
