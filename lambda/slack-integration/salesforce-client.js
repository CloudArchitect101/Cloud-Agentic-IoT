'use strict';

const jsforce = require('jsforce');
const { getSession } = require('@cloud-agentic-iot/shared/salesforce');
const { requiredEnv } = require('@cloud-agentic-iot/shared/env');

/**
 * Headless service-account auth: no interactive login, no per-user
 * Salesforce credentials ever touch Slack. A single dedicated integration
 * user, scoped to the minimum permissions this Lambda needs, authenticates
 * through the JWT Bearer Flow in lambda/shared/salesforce.js, which keeps one
 * token per container instead of fetching one per slash command. The private
 * key is read from SSM (a SecureString) at runtime. See
 * docs/CI-CD-SECRETS.md for how the External Client App behind this is set up.
 */
async function getSalesforceConnection() {
  const { instanceUrl, accessToken } = await getSession();
  return new jsforce.Connection({ instanceUrl, accessToken, version: requiredEnv('SALESFORCE_API_VERSION') });
}

module.exports = { getSalesforceConnection };
