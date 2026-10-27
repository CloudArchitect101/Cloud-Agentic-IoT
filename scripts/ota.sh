#!/usr/bin/env bash
#
# ota.sh - ship firmware to boards over the air, through AWS IoT Jobs.
#
#   scripts/ota.sh release <Dev|Prod>                        publish every new FIRMWARE_VERSION (pipeline only)
#   scripts/ota.sh promote Prod <sketch> <version>           Prod canary -> every Prod board
#   scripts/ota.sh join <Dev|Prod> <thing> <sketch> [canary] put a board in its group
#   scripts/ota.sh status <Dev|Prod>                         recent jobs, board by board
#
# Where a release goes depends on the environment:
#
#   Dev   every Dev board, straight away (fleet-<sketch>). Dev boards exist to
#         run the newest build.
#   Prod  the canary ring first (canary-<sketch>). Once the canary has run it
#         cleanly, promote sends it to fleet-<sketch> - a person's decision,
#         made from the "OTA promote" workflow.
#
# The bucket, the signing role and the groups come from the ota stack
# (infra/ota/cloudformation.yaml), which the AWS deploy creates.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

usage() {
  sed -n '3,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

# Reads the bucket and signing role from the ota stack, so nobody copies a
# bucket name or role ARN into GitHub by hand.
resolve_ota_stack() {
  local stack
  stack=$(stack_name ota "$1")
  BUCKET=$(stack_output "$stack" FirmwareBucketName)
  PRESIGN_ROLE=$(stack_output "$stack" OtaPresignRoleArn)
  { [ -n "$BUCKET" ] && [ "$BUCKET" != "None" ]; } \
    || die "Stack $stack not found or has no outputs. Deploy AWS first: scripts/deploy-aws.sh $1"
}

known_sketch() {
  grep -qx "$1" <<< "$(sketches)" || die "No sketch named '$1'. Sketches: $(sketches | tr '\n' ' ')"
}

# create_job <job id> <thing group> <sketch> <version> <S3 key> <first-ring|fleet> <environment>
create_job() {
  local job_id="$1" group="$2" sketch="$3" version="$4" key="$5" pace="$6" env="$7" doc
  doc=$(mktemp)
  # The ${aws:iot:s3-presigned-url:...} placeholder goes to AWS as written:
  # IoT swaps in a fresh signed link for each board when it fetches the job,
  # so no long-lived download link exists anywhere. sketch and version are
  # what the board checks before installing anything.
  jq -n \
    --arg sketch "$sketch" \
    --arg version "$version" \
    --arg url "\${aws:iot:s3-presigned-url:https://s3.$AWS_REGION.amazonaws.com/$BUCKET/$key}" \
    '{operation: "ota", sketch: $sketch, version: $version, url: $url}' > "$doc"

  # The first ring rolls out slowly and stops once a quarter of its boards
  # fail. The fleet ramps up gradually and stops sooner, at a tenth: more
  # boards, more to lose.
  local rollout timeout abort
  if [ "$pace" = first-ring ]; then
    rollout='{"maximumPerMinute":5}'
    timeout='{"inProgressTimeoutInMinutes":10}'
    abort='{"criteriaList":[{"failureType":"FAILED","action":"CANCEL","thresholdPercentage":25,"minNumberOfExecutedThings":2}]}'
  else
    rollout='{"maximumPerMinute":10,"exponentialRate":{"baseRatePerMinute":5,"incrementFactor":2,"rateIncreaseCriteria":{"numberOfSucceededThings":10}}}'
    timeout='{"inProgressTimeoutInMinutes":15}'
    abort='{"criteriaList":[{"failureType":"FAILED","action":"CANCEL","thresholdPercentage":10,"minNumberOfExecutedThings":5}]}'
  fi

  aws iot create-job \
    --job-id "$job_id" \
    --targets "arn:aws:iot:$AWS_REGION:$AWS_ACCOUNT_ID:thinggroup/$group" \
    --document "file://$doc" \
    --description "$sketch $version to $group ($env, $(git -C "$REPO_ROOT" rev-parse --short HEAD))" \
    --presigned-url-config "{\"roleArn\":\"$PRESIGN_ROLE\",\"expiresInSec\":3600}" \
    --job-executions-rollout-config "$rollout" \
    --timeout-config "$timeout" \
    --abort-config "$abort" > /dev/null
  rm -f "$doc"
}

cmd_release() {
  local env="$1" sketch version key bin group ring job_id sha published=0
  # Releases come from the pipeline only. A version published from a laptop is
  # published for good: when the merged code arrives under the same number, the
  # pipeline finds that version already in the bucket and skips it, so the
  # boards never get the code that was actually reviewed. To try firmware on a
  # board before merging, flash it over USB.
  in_ci || die "Releases come from the pipeline. To try firmware on a board first: scripts/firmware.sh flash <sketch>"
  need jq "It builds the job document."
  aws_whoami
  assert_aws_environment "$env"
  resolve_ota_stack "$env"
  sha=$(git -C "$REPO_ROOT" rev-parse --short HEAD)

  for sketch in $(sketches); do
    version=$(version_of < "$REPO_ROOT/firmware/$sketch/$sketch.ino")
    [ -n "$version" ] || die "firmware/$sketch declares no FIRMWARE_VERSION, so it can never be released."
    key="firmware/$sketch/$version.bin"

    # The published binary IS the record that this version shipped: no other
    # state to keep in sync. A merge that did not raise the version - a docs
    # edit, a refactor, a Lambda change - publishes nothing and creates no job.
    if aws s3api head-object --bucket "$BUCKET" --key "$key" > /dev/null 2>&1; then
      echo "  $sketch $version is already published; no job"
      continue
    fi

    if ! arduino-cli core list 2>/dev/null | grep '^esp32:esp32' > /dev/null; then
      "$REPO_ROOT/scripts/firmware.sh" setup
    fi
    "$REPO_ROOT/scripts/firmware.sh" build "$sketch"
    bin="$REPO_ROOT/build/firmware/$sketch/$sketch.ino.bin"
    [ -f "$bin" ] || die "The build produced no $sketch.ino.bin."

    step "Publish $sketch $version"
    aws s3 cp "$bin" "s3://$BUCKET/$key" --sse AES256 --metadata "git-sha=$sha" --only-show-errors
    if [ "$env" = Prod ]; then ring=canary; else ring=fleet; fi
    group="$ring-$sketch"
    job_id="ota-$sketch-${version//./-}-$(date +%s)"
    create_job "$job_id" "$group" "$sketch" "$version" "$key" first-ring "$env"
    endstep
    note "$sketch $version is published; job $job_id is rolling out to $group."
    published=$((published + 1))
  done
  [ "$published" -gt 0 ] || note "No new firmware version, so nothing went to the boards."
}

cmd_promote() {
  local env="$1" sketch="${2:-}" version="${3:-}" key prefix job details ok bad job_id
  [ "$env" = Prod ] || die "Dev releases already go to every Dev board. Promotion is for Prod."
  refuse_local_prod "$env"
  { [ -n "$sketch" ] && [ -n "$version" ]; } || die "Usage: scripts/ota.sh promote Prod <sketch> <version>"
  known_sketch "$sketch"
  need jq "It reads the job results."
  aws_whoami
  assert_aws_environment "$env"
  resolve_ota_stack "$env"

  key="firmware/$sketch/$version.bin"
  aws s3api head-object --bucket "$BUCKET" --key "$key" > /dev/null 2>&1 \
    || die "$sketch $version was never published, so there is nothing to promote."

  # The newest finished canary job for exactly this version. The trailing dash
  # keeps 2.0.1 from matching a 2.0.10 job.
  prefix="ota-$sketch-${version//./-}-"
  job=$(aws iot list-jobs --status COMPLETED \
          --query "jobs[?starts_with(jobId, '$prefix')].jobId" --output json | jq -r 'sort | last // empty')
  [ -n "$job" ] || die "No finished canary job for $sketch $version. Promotion follows a canary; it never replaces one."

  # Finished is not the same as healthy: a job completes even when its boards
  # failed. Promote only when at least one board took the update and none
  # failed, refused it or timed out.
  details=$(aws iot describe-job --job-id "$job" --query job.jobProcessDetails --output json)
  ok=$(jq '.numberOfSucceededThings // 0' <<< "$details")
  bad=$(jq '[.numberOfFailedThings, .numberOfRejectedThings, .numberOfTimedOutThings] | map(. // 0) | add' <<< "$details")
  [ "$ok" -ge 1 ] || die "Canary job $job finished without any board taking the update. Is canary-$sketch empty?"
  [ "$bad" -eq 0 ] || die "Canary job $job: $bad board(s) failed, refused the update or timed out. Not promoting."

  job_id="ota-fleet-$sketch-${version//./-}-$(date +%s)"
  step "Promote $sketch $version to fleet-$sketch"
  create_job "$job_id" "fleet-$sketch" "$sketch" "$version" "$key" fleet "$env"
  endstep
  note "Canary $job: $ok board(s) updated cleanly. Job $job_id is rolling $sketch $version out to fleet-$sketch."
}

# A board belongs to exactly one group of its type: canary-<sketch> sits inside
# fleet-<sketch>, and AWS IoT does not let a thing be in two groups of one
# hierarchy. So joining one group means leaving the other first.
cmd_join() {
  local env="$1" thing="${2:-}" sketch="${3:-}" ring=fleet other=canary
  { [ -n "$thing" ] && [ -n "$sketch" ]; } || die "Usage: scripts/ota.sh join <Dev|Prod> <thing> <sketch> [canary]"
  if [ "${4:-}" = canary ]; then ring=canary; other=fleet; fi
  known_sketch "$sketch"
  aws_whoami
  assert_aws_environment "$env"
  aws iot remove-thing-from-thing-group --thing-name "$thing" --thing-group-name "$other-$sketch" > /dev/null 2>&1 || true
  aws iot add-thing-to-thing-group --thing-name "$thing" --thing-group-name "$ring-$sketch"
  note "$thing is in $ring-$sketch."
}

cmd_status() {
  local env="$1" job
  need jq "It formats the results."
  aws_whoami
  assert_aws_environment "$env"
  for job in $(aws iot list-jobs --query 'jobs[?starts_with(jobId, `ota-`)].jobId' --output json \
                 | jq -r 'sort_by(split("-") | last | tonumber) | reverse | .[:5] | .[]'); do
    aws iot describe-job --job-id "$job" --output json \
      | jq -r '.job | "\(.jobId)  \(.status)  \(.description // "")"'
    aws iot list-job-executions-for-job --job-id "$job" --output json \
      | jq -r '.executionSummaries[] | "    \(.thingArn | split("/") | last)  \(.jobExecutionSummary.status)"'
  done
}

cmd="${1:-}"
env="${2:-}"
[ -n "$cmd" ] || usage
check_environment "$env"
shift 2
case "$cmd" in
  release) cmd_release "$env" ;;
  promote) cmd_promote "$env" "$@" ;;
  join)    cmd_join "$env" "$@" ;;
  status)  cmd_status "$env" ;;
  *)       usage ;;
esac
