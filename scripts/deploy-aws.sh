#!/usr/bin/env bash
#
# deploy-aws.sh - deploy every CloudFormation stack, then the real Lambda code,
# into one environment's AWS account.
#
#   AWS_PROFILE=iot-dev scripts/deploy-aws.sh Dev
#
# The pipeline runs this same script on every merge into Dev or Prod, so
# running it yourself first is how you find out what the merge will do. From a
# laptop it deploys Dev only; Prod is refused (see lib/common.sh).

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ENV="${1:-}"
check_environment "$ENV"
refuse_local_prod "$ENV"
need zip "It packages the Lambda source."
need npm "It installs each function's dependencies."
cd "$REPO_ROOT"

aws_whoami
assert_aws_environment "$ENV"

templates=$(find . -name cloudformation.yaml -not -path "*/node_modules/*" | sort)

step "Validate every template before deploying any of them"
for t in $templates; do
  echo "  $t"
  aws cloudformation validate-template --template-body "file://$t" > /dev/null
done
endstep

# Each template becomes the stack cloud-agentic-iot-<its directory>-<env>.
# Slack is left out here: it is the one stack that needs a third-party app to
# exist first, so one unconfigured integration must not fail the deploy of the
# device pipeline, which has nothing to do with Slack.
deployed=0
for t in $templates; do
  name=$(basename "$(dirname "$t")")
  [ "$name" = "slack-integration" ] && continue
  step "Deploy $t as $(stack_name "$name" "$ENV")"
  aws cloudformation deploy \
    --template-file "$t" \
    --stack-name "$(stack_name "$name" "$ENV")" \
    --capabilities CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset
  endstep
  deployed=$((deployed + 1))
done

# The Slack template reads its signing secret from SSM, and CloudFormation
# refuses to build a change set when that parameter is missing. Check first and
# skip with a plain message instead of dying on "Unable to fetch parameters".
slack_deployed=false
if aws ssm get-parameter --name /cloud-agentic-iot/slack/signing-secret > /dev/null 2>&1; then
  step "Deploy lambda/slack-integration/cloudformation.yaml"
  aws cloudformation deploy \
    --template-file lambda/slack-integration/cloudformation.yaml \
    --stack-name "$(stack_name slack-integration "$ENV")" \
    --capabilities CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset
  endstep
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
  # Built in a scratch copy, so whatever node_modules your checkout has never
  # ends up in the zip: the function gets exactly its declared dependencies.
  build=$(mktemp -d)
  cp -R "$dir/." "$build/"
  rm -rf "$build/node_modules"
  if [ -f "$build/package.json" ]; then
    (cd "$build" && npm install --omit=dev --no-audit --no-fund --loglevel=error)
  fi
  (cd "$build" && zip -qr "$build.zip" .)
  aws lambda wait function-updated --function-name "$fn"
  aws lambda update-function-code --function-name "$fn" \
    --zip-file "fileb://$build.zip" --publish > /dev/null
  rm -rf "$build" "$build.zip"
  packaged=$((packaged + 1))
  endstep
done < <(find lambda -name index.js -not -path "*/node_modules/*" | sort)

note "AWS $ENV is deployed: $deployed stack(s), $packaged function(s) running the code in this commit."
