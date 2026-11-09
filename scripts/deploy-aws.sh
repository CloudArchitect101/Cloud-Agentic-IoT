#!/usr/bin/env bash
#
# deploy-aws.sh - deploy every CloudFormation stack, then the real Lambda code,
# into one environment's AWS account.
#
#   AWS_PROFILE=iot-dev scripts/deploy-aws.sh Dev
#
# The pipeline runs this same script on every merge into Dev or Prod, so
# running it yourself first is how you find out what the merge will do. From a
# laptop it deploys Dev only; Prod is refused (see lib/common.sh). It also
# refuses uncommitted changes under lambda/, infra/, config/, scripts/ and knowledge/
# (ALLOW_DIRTY=yes overrides), and records the commit it shipped in SSM,
# /cloud-agentic-iot/deployed-commit/aws.
#
# scripts/seed-ssm.sh runs first: the stacks read the Salesforce settings it
# writes.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ENV="${1:-}"
check_environment "$ENV"
refuse_local_prod "$ENV"
need zip "It packages the Lambda source."
need npm "It installs each function's dependencies."
need node "It reads config/$ENV.json."
cd "$REPO_ROOT"

require_committed
aws_whoami
assert_aws_environment "$ENV"

templates=$(find . -name cloudformation.yaml -not -path "*/node_modules/*" | sort)

step "Validate every template before deploying any of them"
for t in $templates; do
  echo "  $t"
  aws cloudformation validate-template --template-body "file://$t" > /dev/null
done
endstep

# The clinical bands every function scores with. The functions read them from
# SSM at runtime, so a change to config/vital-thresholds.json reaches them on
# this deploy without touching any code; Salesforce holds the same numbers as
# Vital_Sign_Threshold__mdt, and the checks fail when the two differ.
step "Publish the clinical bands to $THRESHOLDS_PARAM"
bands=$(cat config/vital-thresholds.json)
current=$(aws ssm get-parameter --name "$THRESHOLDS_PARAM" --query Parameter.Value --output text 2> /dev/null || true)
if [ "$current" != "$bands" ]; then
  aws ssm put-parameter --name "$THRESHOLDS_PARAM" --type String --overwrite --value "$bands" \
    --description "Clinical bands, from config/vital-thresholds.json. Written by scripts/deploy-aws.sh." > /dev/null
  echo "  updated"
else
  echo "  unchanged"
fi
endstep

# Several templates read Salesforce settings from SSM Parameter Store, and
# CloudFormation fails a stack with "Unable to fetch parameters" when one is
# missing - after it has started. Check them all first and name what is missing.
# (The Slack template is optional and checked on its own, below.)
missing=""
for p in $(grep -h "Default: /$PROJECT/" $templates /dev/null | grep -v /slack/ | sed 's/.*Default: //' | tr -d '\r' | sort -u); do
  aws ssm get-parameter --name "$p" > /dev/null 2>&1 || missing="$missing $p"
done
[ -z "$missing" ] || die "Missing from SSM in this account:$missing. Run scripts/seed-ssm.sh $ENV first: the pipeline runs it from the $ENV environment's secrets, and on a laptop it asks for the values (a value you do not have yet is written as a placeholder)."

# deploy_stack <template> - deploys it as cloud-agentic-iot-<its directory>-<env>,
# sized by the stacks.<directory> section of config/<env>.json: batch sizes,
# concurrency, retention, timeouts. Nothing environment-specific is written in
# a template; its defaults are for a first Dev deploy.
#
# Some values come from the environment rather than the repository, so they
# are passed to whichever template declares them: AlarmTopicArn, the topic of
# the alarms stack, which sorts first and so is deployed before the rest, and
# the names in FROM_ENVIRONMENT below. Each of those names something outside
# the repository: an address that does not belong in a public repo, or what
# Data Cloud reads the readings archive as (docs/DATA-CLOUD.md), which is made
# by hand per account and per org. One left unset is not passed, and
# CloudFormation keeps the value the stack already has.
FROM_ENVIRONMENT="ALARM_EMAIL=AlarmEmail
DATA_CLOUD_OIDC_PROVIDER_ARN=DataCloudOidcProviderArn
DATA_CLOUD_EXTERNAL_ID=DataCloudExternalId
DATA_CLOUD_READER_USER=DataCloudReaderUserName"
ALARM_TOPIC_ARN=""
OTA_BUCKET=""
OTA_PRESIGN_ROLE=""
declares() { grep -q "^  $2:[[:space:]]*\$" "$1"; }   # declares <template> <parameter>
deploy_stack() {
  local t="$1" name overrides line variable parameter
  name=$(basename "$(dirname "$t")")
  overrides=$(node scripts/lib/stack-parameters.js "$ENV" "$t") || die "config/$ENV.json does not fit $t (above)."
  while IFS='=' read -r variable parameter; do
    if [ -n "${!variable:-}" ] && declares "$t" "$parameter"; then
      overrides="${overrides:+$overrides
}$parameter=${!variable}"
    fi
  done <<< "$FROM_ENVIRONMENT"
  if [ -n "$ALARM_TOPIC_ARN" ] && declares "$t" AlarmTopicArn; then
    overrides="${overrides:+$overrides
}AlarmTopicArn=$ALARM_TOPIC_ARN"
  fi
  # The firmware bucket and the signing role, for the OTA saga (lambda/ota-saga).
  if [ -n "$OTA_BUCKET" ] && declares "$t" FirmwareBucketName; then
    overrides="${overrides:+$overrides
}FirmwareBucketName=$OTA_BUCKET
OtaPresignRoleArn=$OTA_PRESIGN_ROLE"
  fi
  local args=()
  if [ -n "$overrides" ]; then
    args=(--parameter-overrides)
    while IFS= read -r line; do args+=("$line"); done <<< "$overrides"
  fi
  step "Deploy $t as $(stack_name "$name" "$ENV")"
  aws cloudformation deploy \
    --template-file "$t" \
    --stack-name "$(stack_name "$name" "$ENV")" \
    --capabilities CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset \
    ${args[@]+"${args[@]}"}
  endstep
  if [ "$name" = alarms ]; then
    ALARM_TOPIC_ARN=$(stack_output "$(stack_name alarms "$ENV")" AlarmTopicArn)
    [ "$ALARM_TOPIC_ARN" != "None" ] || ALARM_TOPIC_ARN=""
  fi
  if [ "$name" = ota ]; then
    OTA_BUCKET=$(stack_output "$(stack_name ota "$ENV")" FirmwareBucketName)
    OTA_PRESIGN_ROLE=$(stack_output "$(stack_name ota "$ENV")" OtaPresignRoleArn)
    [ -n "$OTA_BUCKET" ] && [ "$OTA_BUCKET" != "None" ] && [ -n "$OTA_PRESIGN_ROLE" ] && [ "$OTA_PRESIGN_ROLE" != "None" ] \
      || die "The ota stack has no FirmwareBucketName or OtaPresignRoleArn output; the OTA saga needs both."
  fi
}

# Slack is left out here: it is the one stack that needs a third-party app to
# exist first, so one unconfigured integration must not fail the deploy of the
# device pipeline, which has nothing to do with Slack.
deployed=0
for t in $templates; do
  [ "$(basename "$(dirname "$t")")" = "slack-integration" ] && continue
  deploy_stack "$t"
  deployed=$((deployed + 1))
done

# The Slack template reads its signing secret from SSM, and CloudFormation
# refuses to build a change set when that parameter is missing. Check first and
# skip with a plain message instead of dying on "Unable to fetch parameters".
slack_deployed=false
if aws ssm get-parameter --name /cloud-agentic-iot/slack/signing-secret > /dev/null 2>&1; then
  deploy_stack lambda/slack-integration/cloudformation.yaml
  slack_deployed=true
  deployed=$((deployed + 1))
else
  warn "No Slack signing secret in SSM, so the Slack stack was skipped. Everything else deployed."
fi

# The templates carry a placeholder handler so each stack can be created on
# its own. The real source sits next to the template, so every function a
# template declares is packaged and pushed over the placeholder here - without
# this step the stacks deploy green while running placeholder code.
#
# Only functions a template declares are packaged: the repo holds source for
# several functions whose infrastructure is not written yet. A new template
# needs no change here: lambda/guardrails and lambda/mcp-server are deployed
# and packaged because their templates declare cloud-agentic-iot-guardrails
# and cloud-agentic-iot-mcp-server. If a template
# declares a function and the source directory does not match its name, that
# still fails loudly.
# Lambda makes each function's log group, /aws/lambda/<name>, on its first
# run, and keeps it forever. Making it here first, or finding it, and setting
# its retention from config/<env>.json bounds what the logs cost.
retention=$(node -p "require('./config/$ENV.json').lambdaLogRetentionDays") \
  || die "config/$ENV.json has no lambdaLogRetentionDays."
keep_logs() {   # keep_logs <function>
  local group="/aws/lambda/$1" out
  out=$(aws logs create-log-group --log-group-name "$group" 2>&1) \
    || [[ "$out" == *ResourceAlreadyExistsException* ]] \
    || die "Could not create $group: $out"
  aws logs put-retention-policy --log-group-name "$group" --retention-in-days "$retention"
}

declared=$(grep -rh "FunctionName: $PROJECT" --include=cloudformation.yaml . \
             | sed 's/.*FunctionName: //' | tr -d '\r' | sort -u)

packaged=0
while IFS= read -r src; do
  dir=$(dirname "$src")
  fn="$PROJECT-$(basename "$dir")"

  if ! grep -qx "$fn" <<< "$declared"; then
    echo "  skip $dir: no template declares $fn"
    continue
  fi
  if [ "$slack_deployed" != true ] && [ "$(basename "$dir")" = "slack-integration" ]; then
    echo "  skip $dir: the Slack stack was not deployed"
    continue
  fi
  aws lambda get-function --function-name "$fn" > /dev/null 2>&1 \
    || die "$fn is declared in a template but does not exist in this account. FunctionName must be $PROJECT-<source directory name>."

  step "Package $dir as $fn"
  zipfile=$(package_function "$dir")
  aws lambda wait function-updated --function-name "$fn"
  aws lambda update-function-code --function-name "$fn" \
    --zip-file "fileb://$zipfile" --publish > /dev/null
  rm -f "$zipfile"
  keep_logs "$fn"
  echo "  logs kept $retention days"
  packaged=$((packaged + 1))
  endstep
done < <(find lambda -name index.js -not -path "*/node_modules/*" | sort)

# The ward procedures the Patient Care Agent cites: embedded into the index
# its Find Procedure action searches, from the knowledge/sops this commit
# holds. Unchanged SOPs are not embedded again (docs/SOP-GROUNDING.md).
# SKIP_SOP_INDEX=yes leaves the index as it is, for an account Bedrock
# has not authorized yet: everything else deploys, and Find Procedure
# answers that no procedure is indexed until scripts/index-sops.sh runs.
if [ "${SKIP_SOP_INDEX:-}" = "yes" ]; then
  note "SKIP_SOP_INDEX=yes: the ward procedures were not indexed. Run scripts/index-sops.sh $ENV once Bedrock works in this account."
else
  AWS_ENVIRONMENT_CHECKED="$ENV" scripts/index-sops.sh "$ENV"
fi

# The MCP server's address and the role a client signs its requests as
# (docs/GUARDRAILS-AND-MCP.md). Printed rather than stored: neither is a
# secret, and the stack's outputs are where they live.
mcp_stack=$(stack_name mcp-server "$ENV")
mcp_endpoint=$(stack_output "$mcp_stack" McpServerEndpoint)
if [ -n "$mcp_endpoint" ] && [ "$mcp_endpoint" != "None" ]; then
  note "MCP server: $mcp_endpoint - SigV4 for the lambda service, as $(stack_output "$mcp_stack" McpClientRoleArn). docs/GUARDRAILS-AND-MCP.md says how to connect a client."
fi

record_deployed_commit aws
note "AWS $ENV is deployed: $deployed stack(s), $packaged function(s) running the code in $(deployed_commit)."
