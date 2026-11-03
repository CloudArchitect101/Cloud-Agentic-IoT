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
