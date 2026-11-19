#!/usr/bin/env node
'use strict';

/*
 * mcp-probe.js - check the outside MCP servers in config/mcp-servers.json.
 *
 *   node scripts/lib/mcp-probe.js [config/mcp-servers.json] [--json]
 *
 * Read-only and free: it sends one MCP initialize per server (plus
 * tools/list for a server without auth) and reads the OAuth metadata. It
 * never signs in and never calls a tool, so it uses none of a user's
 * Espressif rate limit.
 *
 *  oauth-per-user  expects 401 with a resource_metadata link (RFC 9728), then
 *                  reads the authorization server metadata (RFC 8414) and
 *                  checks the endpoints, the grant and PKCE match what the
 *                  org's External Auth Identity Provider was set up with.
 *  none            expects initialize to succeed and tools/list to still
 *                  offer every allowlisted tool.
 *
 * Prints one line per server with its latency (Agentforce's MCP client gives
 * up after 60 s) and exits 1 if any server fails, so it can run before a
 * demo or on a schedule.
 */

const fs = require('node:fs');

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cloud-agentic-iot-probe', version: '1' } },
};
const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
// Agentforce's documented tool-name pattern (Considerations for MCP for
// Agentforce). Names outside it still registered in practice; reported as a
// warning so a refusal is not a surprise.
const AGENTFORCE_TOOL_NAME = /^[a-zA-Z0-9./-]{1,128}$/;
const CLIENT_TIMEOUT_MS = 60000;

/** Body of a JSON or a one-event text/event-stream answer. */
function parseRpc(text) {
  const data = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
  return JSON.parse(data || text);
}

/** RFC 8414: the well-known path goes before the issuer's path. */
function asMetadataUrl(issuer) {
  const u = new URL(issuer);
  const tail = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  return `${u.origin}/.well-known/oauth-authorization-server${tail}`;
}

function resourceMetadataUrl(wwwAuthenticate) {
  const m = /resource_metadata="([^"]+)"/.exec(wwwAuthenticate || '');
  return m ? m[1] : null;
}

async function probeOAuth(server, res, fetchImpl, problems, facts) {
  if (res.status !== 401) {
    problems.push(`expected 401 without a token, got ${res.status}`);
    return;
  }
  const prmUrl = resourceMetadataUrl(res.headers.get('www-authenticate'));
  if (!prmUrl) {
    problems.push('401 without a resource_metadata link');
    return;
  }
  const prm = await (await fetchImpl(prmUrl)).json();
  const issuer = (prm.authorization_servers || [])[0];
  if (!issuer) {
    problems.push('protected resource metadata names no authorization server');
    return;
  }
  const as = await (await fetchImpl(asMetadataUrl(issuer))).json();
  const want = server.auth;
  const check = (label, got, expected) => {
    facts[label] = got;
    if (expected !== undefined && got !== expected) problems.push(`${label} is ${got}, the org was set up with ${expected}`);
  };
  check('authorizeUrl', as.authorization_endpoint, want.authorizeUrl);
  check('tokenUrl', as.token_endpoint, want.tokenUrl);
  check('registrationUrl', as.registration_endpoint, want.registrationUrl);
  if (!(as.grant_types_supported || ['authorization_code']).includes(want.grant)) problems.push(`grant ${want.grant} is no longer offered`);
  if (want.pkce && !(as.code_challenge_methods_supported || []).includes(want.pkce)) problems.push(`PKCE ${want.pkce} is no longer offered`);
  if (want.clientAuth && !(as.token_endpoint_auth_methods_supported || [want.clientAuth]).includes(want.clientAuth)) problems.push(`client auth ${want.clientAuth} is no longer offered`);
  if (want.scope && prm.scopes_supported && !prm.scopes_supported.includes(want.scope)) problems.push(`scope ${want.scope} is no longer offered`);
}

async function probeOpen(server, res, text, fetchImpl, problems, facts) {
  if (!res.ok) {
    problems.push(`initialize answered ${res.status}`);
    return;
  }
  parseRpc(text);
  const headers = { ...HEADERS };
  const sid = res.headers.get('mcp-session-id');
  if (sid) headers['mcp-session-id'] = sid;
  await fetchImpl(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  const list = await fetchImpl(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  const names = (parseRpc(await list.text()).result?.tools || []).map((t) => t.name);
  facts.tools = names;
  for (const tool of server.tools) if (!names.includes(tool)) problems.push(`allowlisted tool ${tool} is gone`);
}

/** Probes one server. fetchImpl and now are injectable for tests. */
async function probe(server, fetchImpl = fetch, now = Date.now) {
  const problems = [];
  const warnings = [];
  const facts = {};
  const started = now();
  try {
    const res = await fetchImpl(server.url, { method: 'POST', headers: HEADERS, body: JSON.stringify(INIT), signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS) });
    const text = await res.text();
    if (server.auth.type === 'oauth-per-user') await probeOAuth(server, res, fetchImpl, problems, facts);
    else if (server.auth.type === 'none') await probeOpen(server, res, text, fetchImpl, problems, facts);
    else problems.push(`unknown auth type ${server.auth.type}`);
  } catch (err) {
    problems.push(`unreachable: ${err.message}`);
  }
  const latencyMs = now() - started;
  if (latencyMs > CLIENT_TIMEOUT_MS / 2) warnings.push(`slow: ${latencyMs} ms, Agentforce gives up at ${CLIENT_TIMEOUT_MS} ms`);
  for (const tool of server.tools) if (!AGENTFORCE_TOOL_NAME.test(tool)) warnings.push(`tool name ${tool} is outside Agentforce's documented pattern; check it registers`);
  return { name: server.name, url: server.url, ok: problems.length === 0, latencyMs, problems, warnings, facts };
}

async function main(argv) {
  const file = argv.find((a) => !a.startsWith('--')) || 'config/mcp-servers.json';
  const { servers } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const results = [];
  for (const server of servers) results.push(await probe(server));
  if (argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else {
    for (const r of results) {
      console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name} ${r.url} ${r.latencyMs} ms`);
      for (const p of r.problems) console.log(`     problem: ${p}`);
      for (const w of r.warnings) console.log(`     warning: ${w}`);
    }
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

module.exports = { probe, parseRpc, asMetadataUrl, resourceMetadataUrl, AGENTFORCE_TOOL_NAME };

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));
