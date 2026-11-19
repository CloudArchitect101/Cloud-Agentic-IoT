#!/usr/bin/env bash
#
# register-espressif-client.sh - get an OAuth client from the Espressif
# documentation MCP server for one Salesforce org.
#
#   scripts/register-espressif-client.sh '<callback URL>'
#
# The Espressif server (https://mcp.espressif.com/docs) needs a signed-in
# user, so Agentforce reaches it through a per-user External Credential whose
# External Auth Identity Provider needs a client ID and secret. Espressif
# hands those out by OAuth Dynamic Client Registration (RFC 7591) rather than
# a developer console, so this script registers one client for the org's
# callback URL (the one the External Auth Identity Provider page shows).
#
# The client ID and secret are printed here, in your own terminal, once.
# Paste them straight into Setup; never into a file in the repo, a chat or an
# issue. Run it again to get a new client (for example for a new org).
# docs/INSTALL.md step 11b has the clicks around it.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

CALLBACK="${1:-}"
REGISTER_URL="${ESPRESSIF_REGISTER_URL:-https://mcp.espressif.com/docs/register}"
need curl "It calls Espressif's registration endpoint."
need node "It reads the JSON answer."
case "$CALLBACK" in
  https://*.salesforce.com/*|https://*.force.com/*|https://*.salesforce-setup.com/*) ;;
  '') die "Give the Callback URL from Setup > Named Credentials > External Auth Identity Providers > Espressif Docs." ;;
  *) die "'$CALLBACK' does not look like a Salesforce callback URL." ;;
esac

step "Register an OAuth client with Espressif for $CALLBACK"
body=$(node -e '
  const [callback] = process.argv.slice(1);
  console.log(JSON.stringify({
    client_name: "Agentforce (Cloud Agentic IoT)",
    redirect_uris: [callback],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
    scope: "read:user",
  }));' "$CALLBACK")
answer=$(curl -sS --fail-with-body -X POST "$REGISTER_URL" -H 'Content-Type: application/json' -d "$body") \
  || die "Espressif refused the registration: $answer"
node -e '
  const a = JSON.parse(process.argv[1]);
  if (!a.client_id) { console.error("No client_id in the answer: " + process.argv[1]); process.exit(1); }
  console.log("\nClient ID:     " + a.client_id);
  console.log("Client Secret: " + (a.client_secret || "(none: leave the field empty)"));
  console.log("\nPaste both into the External Auth Identity Provider in Setup now. This terminal is the only place they are shown.");' "$answer"
endstep
