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
# By manifest, so the deploy can also remove what left force-app/
# (manifest/destructiveChangesPost.xml). A component the org never had only
# warns, hence --ignore-warnings.
manifest_dir=$(mktemp -d)
sf project generate manifest --source-dir force-app --output-dir "$manifest_dir" --name package >/dev/null
deploy_args=(--manifest "$manifest_dir/package.xml" --post-destructive-changes manifest/destructiveChangesPost.xml
  --ignore-warnings --test-level RunLocalTests --target-org "$org" --wait 30)

step "Validate: check-only deploy, running every local Apex test"
sf project deploy start --dry-run "${deploy_args[@]}"
endstep

if [ "$DRY_RUN" = true ]; then
  rm -rf "$manifest_dir"
  note "Dry run: $org validated, nothing changed."
  exit 0
fi

step "Deploy to $org"
sf project deploy start "${deploy_args[@]}"
endstep
rm -rf "$manifest_dir"
if [ "$paired" = true ]; then record_deployed_commit salesforce; fi

# The integration user writes the readings, so the triggers they fire (a
# room-temperature dose, a Case moving the queue indicator) call AWS as that
# user, through the hand-made AWS_IoT_Relay credential. Give it the callers'
# permission set once that exists (README, Stage 2 part d).
if [ "$paired" = true ]; then
  step "Let the integration user call AWS"
  integration=$(aws ssm get-parameter --name "/$PROJECT/salesforce/username" --query Parameter.Value --output text 2>/dev/null || true)
  callers=$(sf data query --target-org "$org" --json \
    --query "SELECT Id FROM PermissionSet WHERE Name = 'AWS_IoT_Relay_Callers'" 2>/dev/null | jq -r '.result.totalSize // 0' || echo 0)
  if [ -z "$integration" ] || [ "$integration" = "placeholder" ]; then
    warn "No integration username in SSM yet, so AWS_IoT_Relay_Callers was not assigned. Run scripts/seed-ssm.sh $ENV, then deploy again."
  elif [ "$callers" = "0" ]; then
    warn "The org has no AWS_IoT_Relay_Callers permission set yet (README, Stage 2 part d). Until it does and $integration holds it, a room-temperature dose fails with \"couldn't access the credential\"."
  else
    held=$(sf data query --target-org "$org" --json \
      --query "SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.Name = 'AWS_IoT_Relay_Callers' AND Assignee.Username = '$integration'" 2>/dev/null | jq -r '.result.totalSize // 0' || echo 0)
    if [ "$held" = "0" ]; then
      sf org assign permset --name AWS_IoT_Relay_Callers --on-behalf-of "$integration" --target-org "$org"
    else
      echo "  $integration already holds AWS_IoT_Relay_Callers"
    fi
  fi
  endstep
fi
note "Salesforce $ENV is deployed from $(deployed_commit)."
