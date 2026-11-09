#!/usr/bin/env node
// portal-chat-jwk.mjs - turn the patient portal chat certificate into the JWK
// that Messaging for In-App and Web user verification asks for.
//
//   node scripts/portal-chat-jwk.mjs ~/Downloads/Patient_Portal_Chat.crt patient-portal-chat-1
//
// The .crt is the PUBLIC certificate you download from Setup > Certificate and
// Key Management; the private key stays in Salesforce and never touches this
// machine. The second argument is the kid, the same as Key_Id__c in
// Patient_Portal_Setting.Default. Paste the printed JSON into Setup > User
// Verification > New Key (docs/PATIENT-PORTAL.md, step 6).
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

export function jwkFromCertificate(pem, kid) {
  const cert = new X509Certificate(pem);
  const jwk = cert.publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'RSA') {
    throw new Error(`The certificate holds a ${jwk.kty} key; the chat token is signed RS256, so it must be RSA.`);
  }
  const der = cert.raw.toString('base64');
  return { kty: 'RSA', kid, alg: 'RS256', use: 'sig', n: jwk.n, e: jwk.e, x5c: [der] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, kid] = process.argv.slice(2);
  if (!file || !kid) {
    console.error('Usage: node scripts/portal-chat-jwk.mjs <certificate.crt> <kid>');
    process.exit(2);
  }
  console.log(JSON.stringify(jwkFromCertificate(readFileSync(file), kid), null, 2));
}
