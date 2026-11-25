#!/usr/bin/env bash
#
# deploy-salesforce.sh - validate, then deploy, everything in force-app/ to one
# environment's org.
#
#   scripts/deploy-salesforce.sh Dev                # laptop: deploy, no Apex tests
#   scripts/deploy-salesforce.sh Dev --with-tests   # validate with tests, then deploy
#   scripts/deploy-salesforce.sh Dev --dry-run      # validate, change nothing
#
# Apex tests: a laptop deploy to Dev skips them, to keep iterating fast
# (Salesforce allows NoTestRun only in non-production orgs: Developer Edition,
# sandbox, scratch). They always run in the pipeline (CI), on Prod, and with
# --with-tests or RUN_TESTS=yes. Before a feature counts as done, and before
# anything heads to Prod or a recorded deploy, run once with --with-tests.
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
RUN_TESTS="${RUN_TESTS:-}"
for arg in "${@:2}"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --with-tests) RUN_TESTS=yes ;;
    *) die "Unknown option $arg. Use --dry-run and/or --with-tests." ;;
  esac
done
# Tests are never optional where it matters: in the pipeline and on Prod.
if in_ci || [ "$ENV" = "Prod" ]; then RUN_TESTS=yes; fi
[ "$RUN_TESTS" = "yes" ] || RUN_TESTS=no
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
# The patient portal's React app deploys as its build (ui-bundle.json,
# outputDir dist), which Git does not hold, so build it first.
for bundle in force-app/main/default/uiBundles/*/; do
  [ -f "$bundle/package.json" ] || continue
  step "Build the React app in $bundle"
  (cd "$bundle" && npm ci --no-audit --no-fund && npm run build)
  endstep
done

manifest_dir=$(mktemp -d)
sf project generate manifest --source-dir force-app --output-dir "$manifest_dir" --name package >/dev/null
# Agent Script agents (aiAuthoringBundles/) are published, not deployed:
# `sf agent publish authoring-bundle` compiles the script, creates the agent
# and its version, then deploys the bundle (scripts/publish-portal-agent.sh).
node -e '
  const fs = require("fs"); const f = process.argv[1];
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/\s*<types>(?:(?!<\/types>)[\s\S])*<name>AiAuthoringBundle<\/name>\s*<\/types>/, ""));
' "$manifest_dir/package.xml"
deploy_flags=(--manifest "$manifest_dir/package.xml"
  --post-destructive-changes manifest/destructiveChangesPost.xml --ignore-warnings
  --target-org "$org")

if [ "$RUN_TESTS" = "no" ]; then
  # Fast path for iterating: one deploy, no Apex tests. Compile and metadata
  # errors still stop it, before anything changes (the deploy is atomic).
  warn "Skipping Apex tests (laptop deploy to $ENV). Before calling a feature done, run with --with-tests."
  if [ "$DRY_RUN" = true ]; then
    step "Validate: check-only deploy, no Apex tests"
    sf project deploy validate "${deploy_flags[@]}" --test-level NoTestRun --wait 30
    endstep
    rm -rf "$manifest_dir"
    note "Dry run: $org validated without tests, nothing changed."
    exit 0
  fi
  step "Deploy to $org, no Apex tests"
  sf project deploy start "${deploy_flags[@]}" --test-level NoTestRun --wait 30
  endstep
else
# Validate once, then quick-deploy that validation: Salesforce applies the
# package it already compiled and tested, without running the Apex tests a
# second time. It refuses the quick deploy if the org changed since, so it is
# as safe as a second full deploy, in seconds instead of minutes.
step "Validate: check-only deploy, running every local Apex test"
validation=$(sf project deploy validate "${deploy_flags[@]}" \
  --test-level RunLocalTests --async --json | jq -r '.result.id // empty')
[ -n "$validation" ] || die "Salesforce did not start the validation."
note "Validation $validation"
# Readable progress and, on a failure, every component and test that failed.
sf project deploy resume --job-id "$validation" --wait 30
endstep

if [ "$DRY_RUN" = true ]; then
  rm -rf "$manifest_dir"
  note "Dry run: $org validated, nothing changed."
  exit 0
fi

step "Deploy to $org: quick deploy of validation $validation (tests already passed)"
sf project deploy quick --job-id "$validation" --target-org "$org" --wait 30
endstep
fi
rm -rf "$manifest_dir"
if [ "$paired" = true ]; then record_deployed_commit salesforce; fi

# The integration user writes the readings, so the triggers they fire (a
# temperature alert Case moving the queue indicator) call AWS as that
# user, through the hand-made AWS_IoT_Relay credential. Give it the callers'
# permission set once that exists (docs/INSTALL-GUIDE.md, Stage 2 part d).
if [ "$paired" = true ]; then
  step "Let the integration user call AWS"
  integration=$(aws ssm get-parameter --name "/$PROJECT/salesforce/username" --query Parameter.Value --output text 2>/dev/null || true)
  callers=$(sf data query --target-org "$org" --json \
    --query "SELECT Id FROM PermissionSet WHERE Name = 'AWS_IoT_Relay_Callers'" 2>/dev/null | jq -r '.result.totalSize // 0' || echo 0)
  if [ -z "$integration" ] || [ "$integration" = "placeholder" ]; then
    warn "No integration username in SSM yet, so AWS_IoT_Relay_Callers was not assigned. Run scripts/seed-ssm.sh $ENV, then deploy again."
  elif [ "$callers" = "0" ]; then
    warn "The org has no AWS_IoT_Relay_Callers permission set yet (docs/INSTALL-GUIDE.md, Stage 2 part d). Until it does and $integration holds it, a temperature alert Case cannot move the queue indicator: \"couldn't access the credential\"."
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

# Portal patients (Patient_Portal_User) and the portal agent's user
# (Patient_Portal_Agent) read the board's newest reading from AWS, so they
# need the credential's principal access too. It lives in the hand-made
# AWS_IoT_Relay_Callers, never in the repo's sets: a deploy replaces a repo
# set whole, so access added to one by hand vanishes at the next deploy.
# One Apex insert covers any number of users (DML rows limit 10,000).
callers=${callers:-$(sf data query --target-org "$org" --json \
  --query "SELECT Id FROM PermissionSet WHERE Name = 'AWS_IoT_Relay_Callers'" 2>/dev/null | jq -r '.result.totalSize // 0' || echo 0)}
if [ -n "$callers" ] && [ "$callers" != "0" ]; then
  step "Let portal patients and the portal agent call AWS"
  # A callout needs Read on User External Credentials too, and the Customer
  # Community licence refuses it ("Read ExternalDataConnector"), so it lives
  # in the repo's AWS_IoT_Relay_Credential_Reader, never in the hand-made set.
  # 1. Internal holders of AWS_IoT_Relay_Callers (and the Automated Process
  #    user) get the reader set. 2. Orgs set up before Nov 25 put the Read in
  #    AWS_IoT_Relay_Callers itself: take it out, now that 1 covers them,
  #    or no portal patient can be given the set. A set made in Setup records
  #    that Read as ExternalDataConnector; metadata calls it
  #    UserExternalCredential, so match both. 3. Portal users get it.
  apex_file=$(mktemp)
  cat > "$apex_file" <<'APEX'
Id callers = [SELECT Id FROM PermissionSet WHERE Name = 'AWS_IoT_Relay_Callers' LIMIT 1].Id;
List<PermissionSet> readerSets = [SELECT Id FROM PermissionSet WHERE Name = 'AWS_IoT_Relay_Credential_Reader' LIMIT 1];
if (!readerSets.isEmpty()) {
    Id reader = readerSets[0].Id;
    List<PermissionSetAssignment> readers = new List<PermissionSetAssignment>();
    for (User u : [SELECT Id FROM User WHERE IsActive = true
            AND (UserType = 'Standard' OR (UserType = 'AutomatedProcess' AND Username LIKE 'autoproc@%'))
            AND Id IN (SELECT AssigneeId FROM PermissionSetAssignment WHERE PermissionSetId = :callers)
            AND Id NOT IN (SELECT AssigneeId FROM PermissionSetAssignment WHERE PermissionSetId = :reader)
            LIMIT 9000]) {
        readers.add(new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = reader));
    }
    insert readers;
    List<ObjectPermissions> inCallers = [SELECT Id, PermissionsRead FROM ObjectPermissions
        WHERE ParentId = :callers AND SobjectType IN ('UserExternalCredential', 'ExternalDataConnector')
        AND PermissionsRead = true];
    for (ObjectPermissions op : inCallers) { op.PermissionsRead = false; }
    update inCallers;
    System.debug(LoggingLevel.ERROR, 'AWS_IoT_Relay_Credential_Reader given to ' + readers.size()
        + ' user(s); Read removed from AWS_IoT_Relay_Callers: ' + !inCallers.isEmpty());
}
List<PermissionSetAssignment> missing = new List<PermissionSetAssignment>();
for (User u : [SELECT Id FROM User WHERE IsActive = true
        AND Id IN (SELECT AssigneeId FROM PermissionSetAssignment
                   WHERE PermissionSet.Name IN ('Patient_Portal_User', 'Patient_Portal_Agent'))
        AND Id NOT IN (SELECT AssigneeId FROM PermissionSetAssignment WHERE PermissionSetId = :callers)
        LIMIT 9000]) {
    missing.add(new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = callers));
}
insert missing;
System.debug(LoggingLevel.ERROR, 'AWS_IoT_Relay_Callers given to ' + missing.size() + ' portal user(s)');
APEX
  sf apex run --file "$apex_file" --target-org "$org" >/dev/null \
    && echo "  portal users who lacked AWS_IoT_Relay_Callers now hold it" \
    || warn "Could not give AWS_IoT_Relay_Callers to portal users; assign it by hand (docs/PATIENT-PORTAL.md step 11)."
  rm -f "$apex_file"
  endstep
fi
note "Salesforce $ENV is deployed from $(deployed_commit)."
note "New objects or fields stay hidden, even from admins, until a permission set grants them: assign the feature's permission set (e.g. Business_Value_Viewer, docs/BUSINESS-VALUE.md)."
