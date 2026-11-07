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
# refuses uncommitted changes under lambda/, infra/, config/ and scripts/
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
deploy_stack() {
  local t="$1" name overrides line
  name=$(basename "$(dirname "$t")")
  overrides=$(node scripts/lib/stack-parameters.js "$ENV" "$t") || die "config/$ENV.json does not fit $t (above)."
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
# several functions whose infrastructure is not written yet. If a template
# declares a function and the source directory does not match its name, that
# still fails loudly.
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
  packaged=$((packaged + 1))
  endstep
done < <(find lambda -name index.js -not -path "*/node_modules/*" | sort)

record_deployed_commit aws
note "AWS $ENV is deployed: $deployed stack(s), $packaged function(s) running the code in $(deployed_commit)."
