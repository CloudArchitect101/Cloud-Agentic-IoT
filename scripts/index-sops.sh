#!/usr/bin/env bash
#
# index-sops.sh - embed the ward's procedures (knowledge/sops/*.md) and write
# the index the Patient Care Agent's Find Procedure action searches.
#
#   AWS_PROFILE=iot-dev scripts/index-sops.sh Dev            index what changed
#   AWS_PROFILE=iot-dev scripts/index-sops.sh Dev --force    rebuild it anyway
#
# scripts/deploy-aws.sh runs this after it has packaged the functions, so
# every deploy keeps the index in step with the commit it ships; run it on
# its own after editing only an SOP. It sends every SOP file to the
# knowledge-indexer function in one invoke, and the function replaces the
# index whole. When the files are what the index was built from, nothing is
# embedded and nothing is written, so a deploy that changed no SOP costs one
# S3 read. docs/SOP-GROUNDING.md explains the design.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ENV="${1:-}"
check_environment "$ENV"
refuse_local_prod "$ENV"
need node "It reads the SOP files."
cd "$REPO_ROOT"

force=""
[ "${2:-}" = "--force" ] && force="--force"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Read and check every SOP before any AWS call: a bad file fails here.
# shellcheck disable=SC2086  # an empty $force is no argument
node scripts/lib/sop-payload.js $force > "$work/payload.json" \
  || die "An SOP in knowledge/sops is not ready to index (above). Fix it and run again."

# deploy-aws.sh has checked the account already, and says so.
if [ "${AWS_ENVIRONMENT_CHECKED:-}" != "$ENV" ]; then
  aws_whoami
  assert_aws_environment "$ENV"
fi

fn="$PROJECT-knowledge-indexer"
step "Index the ward procedures with $fn"
# Right after a deploy the new code may still be going in, and an invoke
# meanwhile runs the old code.
aws lambda wait function-updated --function-name "$fn" \
  || die "$fn is not in this account. Run scripts/deploy-aws.sh $ENV first: it creates the function."
aws lambda invoke --function-name "$fn" --cli-binary-format raw-in-base64-out \
  --payload "fileb://$work/payload.json" "$work/answer.json" > "$work/status.json" \
  || die "Could not invoke $fn. Run scripts/deploy-aws.sh $ENV first: it creates the function."
if grep -q '"FunctionError"' "$work/status.json"; then
  cat "$work/answer.json" >&2; echo >&2
  # "Operation not allowed" with every IAM right in place is an account-level
  # hold: AWS has not yet authorized the account for Bedrock. Say so plainly.
  auth=$(aws bedrock get-foundation-model-availability --model-id amazon.titan-embed-text-v2:0 \
    --query authorizationStatus --output text 2>/dev/null || true)
  if [ "$auth" = "NOT_AUTHORIZED" ]; then
    die "$fn failed: AWS has not authorized this account for Amazon Bedrock in $AWS_REGION (authorizationStatus NOT_AUTHORIZED). IAM can't fix this. Open a free Support case under Account and billing, Account, asking to enable Bedrock for Titan Text Embeddings V2, then run scripts/index-sops.sh $ENV again (docs/SOP-GROUNDING.md, If a step fails)."
  fi
  die "$fn failed (above). If it names Bedrock, check that Titan Text Embeddings V2 is available to this account in $AWS_REGION."
fi
answer=$(cat "$work/answer.json")
if [ "$(node -p "JSON.parse(process.argv[1]).ok === true" "$answer")" != "true" ]; then
  echo "$answer" >&2
  die "$fn did not index the procedures (above)."
fi
node -p "const a = JSON.parse(process.argv[1]); '  ' + (a.unchanged ? 'unchanged: ' : 'indexed: ') + a.documents + ' SOP(s), ' + a.chunks + ' passage(s)'" "$answer"
endstep
