#!/usr/bin/env bash
#
# install.sh - the Quick install's deploy in one run: seed the settings, check,
# deploy AWS and Salesforce, give the people their permission sets, publish the
# agent, then print every value the remaining Setup steps ask for.
#
#   scripts/install.sh Dev
#   DATA_CLOUD_READER_USER=cloud-agentic-iot-data-cloud-reader scripts/install.sh Dev
#
# It only chains the scripts that already exist, in the order docs/INSTALL.md
# gives, so each one keeps its own guards (which account, which org, a clean
# tree). Run it again after any Setup step: every part is safe to repeat. A
# permission set that is already assigned is left alone, and one the org does
# not have yet (AWS_IoT_Relay_Callers before step 6) is reported, not failed.
#
#   SF_TARGET_ORG             the org alias (default iot-<env>-deploy, as the others)
#   DATA_CLOUD_READER_USER    optional: the IAM user Data Cloud reads the bucket as.
#                             Created when missing, then named to the AWS deploy.
#   SKIP_CHECK=yes            skip scripts/check.sh (the local tests)
#   SKIP_AGENT=yes            skip publishing Patient_Care_Agent (each publish is
#                             a new version, so skip it when the script is unchanged)
#
# Prod is never installed from a laptop: the pipeline deploys it.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ENV="${1:-}"
check_environment "$ENV"
refuse_local_prod "$ENV" "Prod is installed by the pipeline: see docs/DEVELOPMENT.md."
need aws "Install the AWS CLI - see docs/INSTALL.md, step 1."
need sf "Install the Salesforce CLI - see docs/INSTALL.md, step 1."
need jq "It reads the CLI's JSON output."
cd "$REPO_ROOT"
org="${SF_TARGET_ORG:-iot-$(tr '[:upper:]' '[:lower:]' <<< "$ENV")-deploy}"
export SF_TARGET_ORG="$org"
scripts="$REPO_ROOT/scripts"

count() {   # count <SOQL>: how many rows, 0 when the query fails
  sf data query --target-org "$org" --json --query "$1" 2>/dev/null | jq -r '.result.totalSize // 0' || echo 0
}

assign() {   # assign <permission set> [username]: once, and only if the set exists
  local set="$1" user="${2:-}" who
  who="${user:-you}"
  if [ "$(count "SELECT Id FROM PermissionSet WHERE Name = '$set'")" = "0" ]; then
    warn "The org has no $set yet, so $who did not get it. Create it (docs/INSTALL.md, step 7d), then run this script again."
    return 0
  fi
  # For another user, ask first. For you, the CLI's own "Duplicate" answer says so.
  if [ -n "$user" ] && [ "$(count "SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.Name = '$set' AND Assignee.Username = '$user'")" != "0" ]; then
    echo "  $who already holds $set"
    return 0
  fi
  local out
  if [ -n "$user" ]; then
    out=$(sf org assign permset --name "$set" --on-behalf-of "$user" --target-org "$org" 2>&1) || true
  else
    out=$(sf org assign permset --name "$set" --target-org "$org" 2>&1) || true
  fi
  case "$out" in
    *[Dd]uplicate*|*already*) echo "  $who already holds $set" ;;
    *[Ee]rror*|*[Ff]ailed*) printf '%s\n' "$out" >&2; die "Could not assign $set to $who." ;;
    *) echo "  $who now holds $set" ;;
  esac
}

if [ -n "${DATA_CLOUD_READER_USER:-}" ]; then
  step "Data Cloud's reader: IAM user $DATA_CLOUD_READER_USER"
  # S3 refuses a bucket policy that names a user who does not exist, so the
  # user comes before the deploy that writes the policy (docs/SETUP.md §7, 3a).
  if aws iam get-user --user-name "$DATA_CLOUD_READER_USER" > /dev/null 2>&1; then
    echo "  exists"
  else
    aws iam create-user --user-name "$DATA_CLOUD_READER_USER" > /dev/null
    echo "  created"
  fi
  export DATA_CLOUD_READER_USER
  endstep
fi

step "Settings into SSM"
if [ -z "${SF_INTEGRATION_JWT_KEY_FILE:-}" ] && [ -z "${SF_INTEGRATION_JWT_KEY:-}" ] \
   && [ -f scripts/server-integration.key ]; then
  export SF_INTEGRATION_JWT_KEY_FILE=scripts/server-integration.key
fi
"$scripts/seed-ssm.sh" "$ENV"
endstep

if [ "${SKIP_CHECK:-}" != "yes" ]; then
  "$scripts/check.sh"
fi
"$scripts/deploy-aws.sh" "$ENV"
"$scripts/deploy-salesforce.sh" "$ENV"

step "Permission sets"
for set in Device_Platform_Admin Platform_Usage_Viewer Patient_Care_Agent AWS_IoT_Relay_Callers; do
  assign "$set"
done
integration=$(aws ssm get-parameter --name "/$PROJECT/salesforce/username" --query Parameter.Value --output text 2>/dev/null || true)
if [ -n "$integration" ] && [ "$integration" != "placeholder" ]; then
  assign Device_Integration "$integration"
else
  warn "No integration username in SSM yet: create the integration user (docs/INSTALL.md, step 5b) and run this script again."
fi
# The queue indicator's platform event trigger runs as the Automated Process
# user, which Setup's user list doesn't show.
if [ "$(count "SELECT Id FROM PermissionSet WHERE Name = 'AWS_IoT_Relay_Callers'")" != "0" ]; then
  if [ "$(count "SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.Name = 'AWS_IoT_Relay_Callers' AND Assignee.UserType = 'AutomatedProcess' AND Assignee.Username LIKE 'autoproc@%'")" = "0" ]; then
    sf apex run --target-org "$org" <<'EOF'
insert new PermissionSetAssignment(
    AssigneeId = [SELECT Id FROM User WHERE UserType = 'AutomatedProcess' AND Username LIKE 'autoproc@%' LIMIT 1].Id,
    PermissionSetId = [SELECT Id FROM PermissionSet WHERE Name = 'AWS_IoT_Relay_Callers'].Id);
EOF
    echo "  the Automated Process user now holds AWS_IoT_Relay_Callers"
  else
    echo "  the Automated Process user already holds AWS_IoT_Relay_Callers"
  fi
fi
endstep

if [ "${SKIP_AGENT:-}" != "yes" ]; then
  "$scripts/publish-agent.sh" "$ENV"
fi

step "Values for the Setup steps"
out() {   # out <label> <stack dir> <output key>
  local value
  value=$(stack_output "$(stack_name "$2" "$ENV")" "$3")
  [ "$value" != "None" ] || value=""   # the CLI's text output for an output the stack lacks
  printf '  %-34s %s\n' "$1" "${value:-(not deployed)}"
}
out "Step 7b, IAM Role ARN"            queue-relay        SalesforceCallerRoleArn
out "Step 7c, named credential URL"    queue-relay        QueueDepthEndpoint
out "Step 8a, Slack Request URL"       slack-integration  SlackCommandsUrl
out "Step 9, Data Cloud bucket"        patient-vitals     ArchiveBucketName
out "Step 9, Data Cloud folder"        patient-vitals     DataCloudFolder
out "Step 11, MCP endpoint"            mcp-server         McpServerEndpoint
out "Step 11, MCP client role"         mcp-server         McpClientRoleArn
endstep
note "$ENV is installed. Carry on with docs/INSTALL.md, step 7."
