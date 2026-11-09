// The JWK printed for Messaging user verification must describe the same key
// that signs the chat token: RSA, RS256, the configured kid, and a modulus
// and exponent that verify a signature made with the private key.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('the JWK verifies a token signed with the certificate\'s key', async (t) => {
  let pem, key;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwk-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Patient_Portal_Chat',
      '-days', '1', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.crt')], { stdio: 'ignore' });
    pem = fs.readFileSync(path.join(dir, 'c.crt'));
    key = fs.readFileSync(path.join(dir, 'k.pem'));
  } catch {
    t.skip('openssl is not installed');
    return;
  }
  const { jwkFromCertificate } = await import('../../scripts/portal-chat-jwk.mjs');
  const jwk = jwkFromCertificate(pem, 'patient-portal-chat-1');
  assert.equal(jwk.kid, 'patient-portal-chat-1');
  assert.equal(jwk.alg, 'RS256');
  assert.equal(jwk.e, 'AQAB');
  const input = Buffer.from('header.payload');
  const signature = crypto.sign('RSA-SHA256', input, key);
  const pub = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
  assert.ok(crypto.verify('RSA-SHA256', input, pub, signature));
  assert.equal(jwk.x5c.length, 1);
});
