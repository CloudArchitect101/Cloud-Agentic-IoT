#!/usr/bin/env bash
#
# deploy-salesforce.sh - validate, then deploy, everything in force-app/ to one
# environment's org.
#
#   scripts/deploy-salesforce.sh Dev             # validate with tests, then deploy
#   scripts/deploy-salesforce.sh Dev --dry-run   # validate with tests, change nothing
#
# On a laptop it deploys as the deploy user (alias iot-dev-deploy, set up in
# docs/SETUP.md, "The deploy user can actually deploy"), not as you. That is
# deliberate: an admin deploy goes green where the deploy user would fail,
# because components that did not change skip the permission check. Dev looks
# fine and the first Prod deploy fails. Same user as the pipeline, same result.
#
# In the pipeline the workflow logs in with the JWT flow and passes the alias
# in SF_TARGET_ORG.
#
# Before anything changes, it checks that the org is the one paired with the
# environment's AWS account (SSM /cloud-agentic-iot/salesforce/org-id; the
# first deploy pairs them), so it needs the same AWS credentials as
# scripts/deploy-aws.sh. An org with no AWS side at all, such as a scratch org,
# can skip the pairing with ALLOW_UNPAIRED_ORG=yes. A laptop deploy also
# refuses uncommitted changes (ALLOW_DIRTY=yes overrides), and the commit it
# shipped is recorded in SSM, /cloud-agentic-iot/deployed-commit/salesforce.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ENV="${1:-}"
check_environment "$ENV"
refuse_local_prod "$ENV"
DRY_RUN=false
[ "${2:-}" = "--dry-run" ] && DRY_RUN=true
need sf "Install the Salesforce CLI - see docs/SETUP.md."
need jq "It reads the CLI's JSON output."
cd "$REPO_ROOT"

if [ -z "$(find force-app -type f 2>/dev/null | head -1)" ]; then
  note "force-app/ holds no metadata, so there is nothing to deploy."
  exit 0
fi

org="${SF_TARGET_ORG:-iot-$(tr '[:upper:]' '[:lower:]' <<< "$ENV")-deploy}"
user=$(sf org display --target-org "$org" --json 2>/dev/null | jq -r '.result.username // empty' || true)
[ -n "$user" ] || die "No authorized org with alias $org. Log in as the deploy user first: docs/SETUP.md, \"The deploy user can actually deploy\"."
echo "Salesforce org $org, as $user"
case "$user" in
  deploy@*) ;;
  *) warn "$user is not the deploy user. A deploy as anyone else can pass where the pipeline fails." ;;
esac

if [ "$DRY_RUN" = false ]; then require_committed; fi

paired=true
if [ "${ALLOW_UNPAIRED_ORG:-}" = "yes" ]; then
  paired=false
  warn "ALLOW_UNPAIRED_ORG=yes: not checking which AWS account $org belongs with, and recording nothing in AWS."
else
  aws_whoami
  assert_aws_environment "$ENV"
  org_id=$(sf org display --target-org "$org" --json 2>/dev/null | jq -r '.result.id // empty' || true)
  [ -n "$org_id" ] || die "Could not read the org ID of $org."
  if [ "$DRY_RUN" = true ]; then assert_sf_org "$org" "$org_id" --dry-run; else assert_sf_org "$org" "$org_id"; fi
fi

# Check-only first: every component compiles and every local Apex test passes,
# and nothing in the org changes. On Prod a bad deploy fails here, before it
# touches anything.
step "Validate: check-only deploy, running every local Apex test"
sf project deploy start --dry-run --test-level RunLocalTests --target-org "$org" --wait 30
endstep

if [ "$DRY_RUN" = true ]; then
  note "Dry run: $org validated, nothing changed."
  exit 0
fi

step "Deploy to $org"
sf project deploy start --test-level RunLocalTests --target-org "$org" --wait 30
endstep
if [ "$paired" = true ]; then record_deployed_commit salesforce; fi
note "Salesforce $ENV is deployed from $(deployed_commit)."
