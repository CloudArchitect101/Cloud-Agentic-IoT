#!/usr/bin/env bash
#
# install.sh - the Quick install's deploy in one run: seed the settings, check,
# deploy AWS and Salesforce, give the people their permission sets, publish the
# agent on a first install, then print every value the remaining Setup steps
# ask for.
#
#   scripts/install.sh Dev
#   DATA_CLOUD_READER_USER=cloud-agentic-iot-data-cloud-reader scripts/install.sh Dev
#
# It only chains the scripts that already exist, in the order docs/INSTALL.md
# gives, so each one keeps its own guards (which account, which org, a clean
# tree). Run it again after any Setup step: every part is safe to repeat (an
# agent the org already runs is left as it is, see REPUBLISH_AGENT below). A
# permission set that is already assigned is left alone, and one the org does
# not have yet is reported, not failed. It also creates the AWS_IoT_Relay
# credential pieces the org lacks (scripts/bootstrap-salesforce.sh), with this
# environment's URL and Region; what exists is never changed, and the access
# key and role ARN stay yours to type in Setup (docs/INSTALL.md, step 7).
#
#   SF_TARGET_ORG             the org alias (default iot-<env>-deploy, as the others)
#   DATA_CLOUD_READER_USER    optional: the IAM user Data Cloud reads the bucket as.
#                             Created when missing, then named to the AWS deploy.
#   SKIP_CHECK=yes            skip scripts/check.sh (the local tests)
#   SKIP_SOP_INDEX=yes        passed on to deploy-aws.sh: skip the Bedrock SOP index while
#                             the account's Bedrock hold is open (docs/INSTALL.md, step 2)
#   SKIP_BOOTSTRAP=yes        do not create the AWS_IoT_Relay credential pieces; make
#                             them in Setup instead (docs/INSTALL.md, step 7)
#   SKIP_AGENT=yes            never publish Patient_Care_Agent
#   REPUBLISH_AGENT=yes       publish it even though the org already has an active
#                             version. Without this a second run leaves the agent
#                             alone: a publish replaces it with the repo's copy,
#                             which drops actions added by hand in Agentforce
#                             Builder (the Espressif MCP actions, INSTALL step 11)
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

count() {   # count <SOQL>: how many rows, 0 when the query fails. Always one value.
  local out
  out=$(sf data query --target-org "$org" --json --query "$1" 2>/dev/null) || { echo 0; return; }
  jq -r '.result.totalSize // 0' <<< "$out" 2>/dev/null || echo 0
}

agent_versions() {   # how many active versions Patient_Care_Agent has; "unknown" when the org would not say
  local out
  out=$(sf data query --target-org "$org" --json \
    --query "SELECT Id FROM BotVersion WHERE BotDefinition.DeveloperName = 'Patient_Care_Agent' AND Status = 'Active'" 2>/dev/null) \
    || { echo unknown; return; }
  jq -r '.result.totalSize // "unknown"' <<< "$out" 2>/dev/null || echo unknown
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

# The credential Salesforce calls AWS with: created once, with this
# environment's values, when the org has none. Never fatal: an org where it
# cannot be created is set up by hand, as before.
if [ "${SKIP_BOOTSTRAP:-}" != "yes" ]; then
  api_url=$(stack_output "$(stack_name queue-relay "$ENV")" QueueDepthEndpoint)
  region="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
  bootstrap_args=("$org")
  case "$api_url" in https://*) bootstrap_args+=(--url "$api_url") ;; esac
  if [ -n "$region" ]; then bootstrap_args+=(--region "$region"); fi
  "$scripts/bootstrap-salesforce.sh" "${bootstrap_args[@]}" \
    || warn "Could not create the AWS_IoT_Relay credential pieces in $org. Make them in Setup (docs/INSTALL.md, step 7) and run this script again."
fi

step "Permission sets"
for set in Device_Platform_Admin Platform_Usage_Viewer Patient_Care_Agent AWS_IoT_Relay_Credential_Reader AWS_IoT_Relay_Callers; do
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
  # Its callouts also need Read on User External Credentials, which lives in
  # the repo set, not in AWS_IoT_Relay_Callers (docs/INSTALL-GUIDE.md, part d).
  if [ "$(count "SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.Name = 'AWS_IoT_Relay_Credential_Reader' AND Assignee.UserType = 'AutomatedProcess' AND Assignee.Username LIKE 'autoproc@%'")" = "0" ]; then
    sf apex run --target-org "$org" <<'EOF'
insert new PermissionSetAssignment(
    AssigneeId = [SELECT Id FROM User WHERE UserType = 'AutomatedProcess' AND Username LIKE 'autoproc@%' LIMIT 1].Id,
    PermissionSetId = [SELECT Id FROM PermissionSet WHERE Name = 'AWS_IoT_Relay_Credential_Reader'].Id);
EOF
    echo "  the Automated Process user now holds AWS_IoT_Relay_Credential_Reader"
  fi
fi
endstep

# Publish the agent on a first install only. A publish replaces the org's
# agent with the repo's copy, so on an org that already runs one it would
# drop whatever was added in Agentforce Builder since.
# Only an answer of exactly 0 active versions counts as a first install: when
# the org would not say, leaving the agent alone is the choice that loses nothing.
if [ "${SKIP_AGENT:-}" = "yes" ]; then
  :
elif [ "${REPUBLISH_AGENT:-}" = "yes" ]; then
  "$scripts/publish-agent.sh" "$ENV"
else
  active=$(agent_versions)
  case "$active" in
    0) "$scripts/publish-agent.sh" "$ENV" ;;
    unknown) warn "Could not tell whether Patient_Care_Agent already runs in $org (is Agentforce on? docs/INSTALL.md, step 3), so it was not published. On a first install, run again with REPUBLISH_AGENT=yes." ;;
    *) note "Patient_Care_Agent already has an active version, so it was not published again. To replace it with the repo's copy (this drops actions added by hand in Agentforce Builder), run again with REPUBLISH_AGENT=yes." ;;
  esac
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
