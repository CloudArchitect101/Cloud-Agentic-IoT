const jwt = require('jsonwebtoken');
const jsforce = require('jsforce');

/**
 * Headless service-account auth: no interactive login, no per-user
 * Salesforce credentials ever touch Slack. A single dedicated integration
 * user, scoped to the minimum permissions this Lambda needs, authenticates
 * via the JWT Bearer Flow. See docs/CI-CD-SECRETS.md for how the Connected
 * App + certificate behind this are set up.
 */
async function getSalesforceConnection() {
  const assertion = jwt.sign(
    {
      iss: process.env.SF_CONSUMER_KEY,
      sub: process.env.SF_USERNAME,
      aud: process.env.SF_LOGIN_URL,
    },
    process.env.SF_JWT_PRIVATE_KEY,
    { algorithm: 'RS256', expiresIn: '3m' }
  );

  const response = await fetch(`${process.env.SF_LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error(`Salesforce JWT auth failed: ${await response.text()}`);
  }

  const { access_token, instance_url } = await response.json();
  return new jsforce.Connection({ instanceUrl: instance_url, accessToken: access_token });
}

module.exports = { getSalesforceConnection };
