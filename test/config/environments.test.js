'use strict';

// config/Dev.json and config/Prod.json hold every per-environment number:
// stack parameters, OTA rollout paces, the fleet's reading interval. A typo
// there would otherwise surface halfway through a deploy, or as an AWS
// validation error on a release. These checks run on every pull request.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { overridesFor, loadConfig } = require('../../scripts/lib/stack-parameters');

const root = path.join(__dirname, '../..');
const environments = ['Dev', 'Prod'];

for (const env of environments) {
  const config = loadConfig(env);

  test(`${env}: every stack it configures exists and declares every parameter it sets`, () => {
    for (const stack of Object.keys(config.stacks || {})) {
      const template = path.join(root, 'lambda', stack, 'cloudformation.yaml');
      assert.ok(fs.existsSync(template), `${env}: stacks.${stack} has no lambda/${stack}/cloudformation.yaml`);
      assert.doesNotThrow(() => overridesFor(env, template));
    }
  });

  test(`${env}: every SQS event source taking more than 10 messages a batch has a batching window`, () => {
    // Lambda refuses a BatchSize over 10 on an SQS queue unless
    // MaximumBatchingWindowInSeconds is at least 1, and says so only when the
    // stack deploys. A setting the config leaves out takes the template default.
    const template = fs.readFileSync(path.join(root, 'lambda', 'patient-vitals', 'cloudformation.yaml'), 'utf8');
    const settings = (config.stacks || {})['patient-vitals'] || {};
    const value = (name) => {
      if (name in settings) return Number(settings[name]);
      const declared = template.match(new RegExp(`^  ${name}:\\n(?:    .*\\n)*?    Default: (\\d+)`, 'm'));
      assert.ok(declared, `lambda/patient-vitals/cloudformation.yaml declares no default for ${name}`);
      return Number(declared[1]);
    };
    for (const kind of ['Ingest', 'Sync', 'Presence']) {
      const size = value(`${kind}BatchSize`);
      const window = value(`${kind}BatchWindowSeconds`);
      assert.ok(size <= 10 || window >= 1, `${env}: ${kind}BatchSize ${size} needs ${kind}BatchWindowSeconds of at least 1, not ${window}`);
    }
  });

  test(`${env}: Lambda logs are kept for a number of days CloudWatch Logs accepts`, () => {
    // scripts/deploy-aws.sh passes it to put-retention-policy, which takes
    // only these values, and says so only once a function has been updated.
    const accepted = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];
    assert.ok(accepted.includes(config.lambdaLogRetentionDays), `${env}: lambdaLogRetentionDays ${config.lambdaLogRetentionDays}`);
  });

  test(`${env}: OTA settings are inside the limits AWS IoT Jobs accepts`, () => {
    const { ota } = config;
    const expires = ota.presignedUrlExpiresInSec;
    assert.ok(Number.isInteger(expires) && expires >= 60 && expires <= 3600, `presignedUrlExpiresInSec ${expires}`);

    for (const ring of ['firstRing', 'fleet']) {
      const { rollout, timeout, abort } = ota[ring];
      const where = `${env} ota.${ring}`;
      assert.ok(rollout.maximumPerMinute >= 1 && rollout.maximumPerMinute <= 1000, `${where}.rollout.maximumPerMinute`);
      if (rollout.exponentialRate) {
        const { baseRatePerMinute, incrementFactor, rateIncreaseCriteria } = rollout.exponentialRate;
        assert.ok(baseRatePerMinute >= 1 && baseRatePerMinute <= rollout.maximumPerMinute, `${where} baseRatePerMinute`);
        assert.ok(incrementFactor >= 1.1 && incrementFactor <= 5, `${where} incrementFactor`);
        assert.ok(rateIncreaseCriteria.numberOfSucceededThings >= 1 || rateIncreaseCriteria.numberOfNotifiedThings >= 1, `${where} rateIncreaseCriteria`);
      }
      assert.ok(timeout.inProgressTimeoutInMinutes >= 1 && timeout.inProgressTimeoutInMinutes <= 10080, `${where}.timeout`);
      assert.ok(abort.criteriaList.length >= 1, `${where}: a rollout with no abort rule never stops on failures`);
      for (const rule of abort.criteriaList) {
        assert.ok(['FAILED', 'REJECTED', 'TIMED_OUT', 'ALL'].includes(rule.failureType), `${where} failureType`);
        assert.equal(rule.action, 'CANCEL');
        assert.ok(rule.thresholdPercentage > 0 && rule.thresholdPercentage <= 100, `${where} thresholdPercentage`);
        assert.ok(Number.isInteger(rule.minNumberOfExecutedThings) && rule.minNumberOfExecutedThings >= 1, `${where} minNumberOfExecutedThings`);
      }
    }
  });
}

test("Prod's canary ring stops on a smaller share of failed boards than Dev's", () => {
  const [dev, prod] = environments.map((env) => loadConfig(env).ota.firstRing);
  const strictest = (abort) => Math.min(...abort.criteriaList.filter((rule) => rule.failureType === 'FAILED').map((rule) => rule.thresholdPercentage));
  assert.ok(strictest(prod.abort) <= strictest(dev.abort), 'Prod canary must abort on a smaller share of failures than Dev');
});

// The MCP server's list_rooms_out_of_range lists a room at or above the same
// threshold that makes patient-vitals flag a reading for Salesforce. Two
// numbers for one rule would have the agent and the care team disagree on
// which rooms are too warm.
test('the MCP server and patient-vitals use one room-temperature threshold', () => {
  const declared = (stack) => {
    const template = fs.readFileSync(path.join(root, 'lambda', stack, 'cloudformation.yaml'), 'utf8');
    return Number(template.match(/^ {2}RoomTempAlertCelsius:\n(?: {4}.*\n)*? {4}Default: (\d+(?:\.\d+)?)/m)[1]);
  };
  assert.equal(declared('mcp-server'), declared('patient-vitals'));
  for (const env of environments) {
    const { stacks } = loadConfig(env);
    const value = (stack) => Number((stacks[stack] || {}).RoomTempAlertCelsius ?? declared(stack));
    assert.equal(value('mcp-server'), value('patient-vitals'), env);
  }
});
