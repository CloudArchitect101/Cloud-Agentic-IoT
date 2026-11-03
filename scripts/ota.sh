#!/usr/bin/env bash
#
# ota.sh - ship firmware to boards over the air, through AWS IoT Jobs.
#
#   scripts/ota.sh release <Dev|Prod>                        publish every new FIRMWARE_VERSION (pipeline only)
#   scripts/ota.sh promote Prod <sketch> <version>           Prod canary -> every Prod board
#   scripts/ota.sh join <Dev|Prod> <thing> <sketch> [canary] put a board in its group
#   scripts/ota.sh status <Dev|Prod>                         recent jobs, board by board
#   scripts/ota.sh interval <Dev|Prod> <sketch> [seconds]    how often every board of a type reports
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
  sed -n '3,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
    || die "Stack $stack not found or has no outputs. Deploy AWS to $1 first: that creates it."
}

# Every rollout pace, timeout, abort rule and link lifetime comes from
# config/<env>.json (.ota), next to the rest of that environment's settings: a
# fleet of a million boards needs a different pace than a desk of three, and
# that is a config change, not a code change.
ota_config() {   # ota_config <env> <jq path>
  local value
  value=$(jq -ce "$2" "$REPO_ROOT/config/$1.json" 2> /dev/null) || die "config/$1.json sets no $2."
  printf '%s' "$value"
}

# The interval range the firmware accepts (DeviceTiming.h); a job outside it
# would only be refused by every board. test/firmware/contract.test.js keeps
# the two in step.
MIN_TELEMETRY_SECONDS=5
MAX_TELEMETRY_SECONDS=86400

known_sketch() {
  grep -qxF "$1" <<< "$(sketches)" || die "No sketch named '$1'. Sketches: $(sketches | tr '\n' ' ')"
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

  # The first ring rolls out slowly and stops early; the fleet ramps up and
  # stops at a smaller share of failures: more boards, more to lose. The
  # numbers for each are in config/<env>.json under .ota.firstRing and .ota.fleet.
  local ring=fleet presign
  [ "$pace" = first-ring ] && ring=firstRing
  presign=$(jq -cn --arg role "$PRESIGN_ROLE" --argjson expires "$(ota_config "$env" .ota.presignedUrlExpiresInSec)" \
              '{roleArn: $role, expiresInSec: $expires}')

  aws iot create-job \
    --job-id "$job_id" \
    --targets "arn:aws:iot:$AWS_REGION:$AWS_ACCOUNT_ID:thinggroup/$group" \
    --document "file://$doc" \
    --description "$sketch $version to $group ($env, $(git -C "$REPO_ROOT" rev-parse --short HEAD))" \
    --presigned-url-config "$presign" \
    --job-executions-rollout-config "$(ota_config "$env" ".ota.$ring.rollout")" \
    --timeout-config "$(ota_config "$env" ".ota.$ring.timeout")" \
    --abort-config "$(ota_config "$env" ".ota.$ring.abort")" > /dev/null
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
                 | jq -r 'sort_by(split("-") | last | tonumber? // 0) | reverse | .[:5] | .[]'); do
    aws iot describe-job --job-id "$job" --output json \
      | jq -r '.job | "\(.jobId)  \(.status)  \(.description // "")"'
    aws iot list-job-executions-for-job --job-id "$job" --output json \
      | jq -r '.executionSummaries[] | "    \(.thingArn | split("/") | last)  \(.jobExecutionSummary.status)"'
  done
}

# How often every board of a type sends a reading. One continuous job for the
# type's fleet group carries the setting: boards that are offline get it when
# they reconnect, boards added to the group later get it when they join, and
# each keeps it in NVS. The group's previous interval job is cancelled once the
# new one exists. Boards on firmware older than 2.1.0 cannot apply it and
# answer FAILED, so send it once the fleet runs 2.1.0 (in Prod: after promote).
cmd_interval() {
  local env="$1" sketch="${2:-}" seconds="${3:-}" group job_id doc old
  [ -n "$sketch" ] || die "Usage: scripts/ota.sh interval <Dev|Prod> <sketch> [seconds]"
  known_sketch "$sketch"
  refuse_local_prod "$env" "Prod boards are set from the pipeline: run the \"Fleet reading interval\" workflow from the Prod branch."
  need jq "It builds the job document."
  [ -n "$seconds" ] || seconds=$(ota_config "$env" ".devices[\"$sketch\"].telemetrySeconds")
  { [[ "$seconds" =~ ^[0-9]+$ ]] && [ "$seconds" -ge "$MIN_TELEMETRY_SECONDS" ] && [ "$seconds" -le "$MAX_TELEMETRY_SECONDS" ]; } \
    || die "The interval must be whole seconds from $MIN_TELEMETRY_SECONDS to $MAX_TELEMETRY_SECONDS, the range the firmware accepts (got '$seconds')."
  aws_whoami
  assert_aws_environment "$env"

  group="fleet-$sketch"
  job_id="interval-$sketch-$seconds-$(date +%s)"
  doc=$(mktemp)
  jq -n --argjson seconds "$seconds" '{operation: "SET_TELEMETRY_INTERVAL", seconds: $seconds}' > "$doc"

  step "Every $sketch in $env reports every $seconds s"
  aws iot create-job \
    --job-id "$job_id" \
    --targets "arn:aws:iot:$AWS_REGION:$AWS_ACCOUNT_ID:thinggroup/$group" \
    --target-selection CONTINUOUS \
    --document "file://$doc" \
    --description "$sketch reports every $seconds s ($env, $(git -C "$REPO_ROOT" rev-parse --short HEAD))" \
    --job-executions-rollout-config "$(ota_config "$env" .ota.fleet.rollout)" \
    --timeout-config "$(ota_config "$env" .ota.fleet.timeout)" \
    --abort-config "$(ota_config "$env" .ota.fleet.abort)" > /dev/null
  rm -f "$doc"
  for old in $(aws iot list-jobs --status IN_PROGRESS --thing-group-name "$group" \
                 --query "jobs[?starts_with(jobId, 'interval-$sketch-')].jobId" --output text); do
    [ "$old" = "$job_id" ] || aws iot cancel-job --job-id "$old" --comment "Replaced by $job_id" > /dev/null
  done
  endstep
  note "Job $job_id sets $seconds s on every board in $group, and on every board that joins it later."
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
  interval) cmd_interval "$env" "$@" ;;
  *)       usage ;;
esac
