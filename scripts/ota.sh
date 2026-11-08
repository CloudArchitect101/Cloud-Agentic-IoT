#!/usr/bin/env bash
#
# ota.sh - ship firmware to boards over the air, through AWS IoT Jobs.
#
#   scripts/ota.sh release <Dev|Prod>                        publish every new FIRMWARE_VERSION (pipeline only)
#   scripts/ota.sh try Dev <sketch>                          from a laptop: this checkout to every Dev board of a type
#   scripts/ota.sh promote Prod <sketch> <version>           Prod canary -> every Prod board
#   scripts/ota.sh join <Dev|Prod> <thing> <sketch> [canary|internal] put a board in its group
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
# A try sends your checkout to the boards a Dev release reaches, before
# anything is merged, under a version no release uses (see cmd_try).
#
# The bucket, the signing role and the groups come from the ota stack
# (infra/ota/cloudformation.yaml), which the AWS deploy creates.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

usage() {
  sed -n '3,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

# create_job <job id> <thing group> <sketch> <version> <S3 key> <first-ring|fleet> <environment> [source]
# The source in the job's description is the commit by default; a try passes
# its own, which says whether the build had changes no commit holds.
create_job() {
  local job_id="$1" group="$2" sketch="$3" version="$4" key="$5" pace="$6" env="$7" source="${8:-}" doc
  [ -n "$source" ] || source=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
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
    --description "$sketch $version to $group ($env, $source)" \
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

# A try sends the build of this checkout to every Dev board of one type, from a
# laptop: the over-the-air test that release, which only the pipeline runs,
# cannot be. Three things keep a try from ever standing in for a release:
#   - Dev only. A Prod board runs reviewed firmware and nothing else.
#   - It is published under firmware/<sketch>/try/, never as
#     firmware/<sketch>/<version>.bin, the key release looks for, so the
#     pipeline still publishes this version once the reviewed code arrives.
#   - The boards run it as <version>-try.<n>, a version release never sends. A
#     board skips only the version it already runs, so a board that ran a try
#     still installs the release of the same number.
# The job is the one a Dev release creates, sent to the same group (and the
# groups inside it) at the same pace and with the same abort rule. A new try
# cancels the earlier tries of that type that boards have not started, so a
# board that was offline installs only the newest when it connects.
cmd_try() {
  local env="$1" sketch="${2:-}" label group boards count base prefix n version key bin sha job_id olds old
  [ "$env" = Dev ] || die "A try goes to Dev boards only. Prod boards take firmware from the pipeline: release, then promote."
  [ -n "$sketch" ] || die "Usage: scripts/ota.sh try Dev <sketch>"
  known_sketch "$sketch"
  need jq "It builds the job document."
  aws_whoami
  # Read the label, never write it: labelling an account is the first deploy's
  # job, and a try is not a deploy. The label lives in one region, so a missing
  # label can also mean the CLI is looking in another region.
  if ! label=$(aws ssm get-parameter --name "$ENV_PARAM" --query Parameter.Value --output text 2>&1); then
    case "$label" in
      *ParameterNotFound*)
        die "AWS account $AWS_ACCOUNT_ID has no environment label in $AWS_REGION. If Dev is deployed in another region, set AWS_REGION to that region; otherwise deploy AWS to Dev first: that labels the account and creates the bucket and groups a try uses." ;;
      *) die "Could not read $ENV_PARAM in $AWS_REGION: $label" ;;
    esac
  fi
  [ "$label" = Dev ] || die "AWS account $AWS_ACCOUNT_ID is labelled $label, not Dev. Check AWS_PROFILE before going any further."
  resolve_ota_stack Dev

  group="fleet-$sketch"
  boards=$(aws iot list-things-in-thing-group --thing-group-name "$group" --recursive --output json \
             | jq -r '.things[]') || die "Could not list the boards in $group."
  [ -n "$boards" ] \
    || die "No board is in $group, so a try would reach nothing. Provisioning puts a board there, or: scripts/ota.sh join Dev <thing> $sketch"
  count=$(printf '%s\n' "$boards" | wc -l | tr -d ' ')

  # The next try number for this version. The bucket keeps what it is given
  # (versioning, no expiry), so a number is not handed out twice.
  base=$(version_of < "$REPO_ROOT/firmware/$sketch/$sketch.ino")
  [ -n "$base" ] || die "firmware/$sketch declares no FIRMWARE_VERSION."
  prefix="firmware/$sketch/try/$base-try."
  n=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "$prefix" --query 'Contents[].Key' --output json \
        | jq -r --arg p "$prefix" '[.[]? | ltrimstr($p) | rtrimstr(".bin") | select(test("^[0-9]+$")) | tonumber] | (max // 0) + 1')
  version="$base-try.$n"
  key="$prefix$n.bin"
  sha=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
  # Anything under firmware/ that the commit does not hold, a new file
  # included, means the build is not that commit's firmware.
  [ -z "$(git -C "$REPO_ROOT" status --porcelain -- firmware)" ] || sha="$sha+local-changes"

  "$REPO_ROOT/scripts/firmware.sh" build-as "$sketch" "$version"
  bin="$REPO_ROOT/build/firmware/$sketch/$sketch.ino.bin"
  [ -f "$bin" ] || die "The build produced no $sketch.ino.bin."

  step "Send $sketch $version to $group: $count board(s)"
  aws s3 cp "$bin" "s3://$BUCKET/$key" --sse AES256 --metadata "git-sha=$sha" --only-show-errors
  job_id="ota-try-$sketch-${version//./-}-$(date +%s)"
  create_job "$job_id" "$group" "$sketch" "$version" "$key" first-ring Dev "$sha"
  # A board takes its jobs oldest first: left alone, an earlier try would go
  # in before this one on every board that has not started it yet.
  olds=$(aws iot list-jobs --status IN_PROGRESS --thing-group-name "$group" \
           --query "jobs[?starts_with(jobId, 'ota-try-$sketch-')].jobId" --output text) \
    || { warn "Could not list the earlier tries; any still waiting for a board stay queued (scripts/ota.sh status Dev)."; olds=""; }
  for old in $olds; do
    [ "$old" != "$job_id" ] || continue
    if aws iot cancel-job --job-id "$old" --comment "Replaced by $job_id" > /dev/null; then
      note "Cancelled the earlier try $old for every board that had not started it."
    else
      warn "Could not cancel the earlier try $old. A board that has not started it installs it first, then this one."
    fi
  done
  endstep
  note "Job $job_id sends $sketch $version ($sha) to $group: $(paste -s -d ' ' - <<< "$boards")"
  watch_job "$job_id" "$count" "$sketch" "$version"
}

# Prints each board's answer as it comes, until every board has answered or
# TRY_WATCH_MINUTES (15 by default) have passed. Ctrl-C stops the watching, not
# the job: AWS IoT keeps it, and a board that is offline takes it when it next
# connects. A poll that fails (the network, a sign-in that ran out) is tried
# again on the next round. Fails if any board failed, refused or timed out.
watch_job() {   # watch_job <job id> <number of boards> <sketch> <version>
  local job="$1" boards="$2" sketch="$3" version="$4" deadline seen="" rows thing status detail
  local answered=0 bad=0 failing=no restarting=""
  deadline=$(( $(date +%s) + ${TRY_WATCH_MINUTES:-15} * 60 ))
  echo "Each board's answer appears below. Ctrl-C stops the watching; the job carries on."
  while :; do
    if rows=$(aws iot list-job-executions-for-job --job-id "$job" --output json \
                | jq -r '.executionSummaries[]? | "\(.thingArn | split("/") | last) \(.jobExecutionSummary.status)"'); then
      failing=no answered=0 bad=0
      while read -r thing status; do
        [ -n "$thing" ] || continue
        case "$status" in
          SUCCEEDED) answered=$((answered + 1)) ;;
          FAILED|REJECTED|TIMED_OUT|REMOVED|CANCELED) answered=$((answered + 1)); bad=$((bad + 1)) ;;
        esac
        if ! grep -qxF "$thing $status" <<< "$seen"; then
          seen="$seen"$'\n'"$thing $status"
          detail=$(aws iot describe-job-execution --job-id "$job" --thing-name "$thing" \
                     --query 'execution.statusDetails.detailsMap.detail' --output text 2> /dev/null || true)
          [ "$detail" != None ] || detail=""
          printf '  %-24s %-11s %s\n' "$thing" "$status" "$detail"
          [ "$status $detail" != "SUCCEEDED rebooting" ] || restarting="$restarting $thing"
        fi
      done <<< "$rows"
      if [ "$answered" -ge "$boards" ]; then break; fi
    elif [ "$failing" = no ]; then
      failing=yes
      warn "Could not read the job's progress just now; trying again. The job carries on either way."
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      note "$((boards - answered)) board(s) have not answered yet. A board that is offline takes the job when it next connects; scripts/ota.sh status Dev shows where it stands."
      break
    fi
    sleep "${TRY_POLL_SECONDS:-10}"
  done
  [ "$bad" -eq 0 ] || die "$bad board(s) did not install $version. The detail beside each one says why."
  # From firmware 2.2.0 a board answers SUCCEEDED ("running <version>") only
  # once the new build has started and reconnected, and FAILED when it came
  # back on another build. Older builds answer SUCCEEDED ("rebooting") just
  # before they restart, so for those the answer alone does not show that the
  # new build started.
  [ -z "$restarting" ] \
    || note "Answered just before restarting, as firmware older than 2.2.0 does:$restarting. The serial console shows whether the new build started: aws: connected, $sketch v$version"
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

# Internal boards (Asset record type Internal_Device in Salesforce, such as a
# nurse-station indicator) run the patient-monitor build like every board, so
# their group sits inside fleet-patient-monitor (infra/ota): a fleet release,
# a promotion, a try and the reading interval reach them as they reach every
# patient monitor. The group only keeps them apart for listing.
INTERNAL_GROUP=internal-devices

# A board belongs to exactly one group of its type: canary-<sketch> (and, for
# patient-monitor, internal-devices) sit inside fleet-<sketch>, and AWS IoT
# does not let a thing be in two groups of one hierarchy. So joining one
# group means leaving the others first.
cmd_join() {
  local env="$1" thing="${2:-}" sketch="${3:-}" ring="${4:-fleet}" target group groups
  { [ -n "$thing" ] && [ -n "$sketch" ]; } || die "Usage: scripts/ota.sh join <Dev|Prod> <thing> <sketch> [canary|internal]"
  known_sketch "$sketch"
  groups="fleet-$sketch canary-$sketch"
  [ "$sketch" = patient-monitor ] && groups="$groups $INTERNAL_GROUP"
  case "$ring" in
    fleet|canary) target="$ring-$sketch" ;;
    internal)
      [ "$sketch" = patient-monitor ] \
        || die "Only a patient-monitor board can be internal: $INTERNAL_GROUP sits inside fleet-patient-monitor."
      target="$INTERNAL_GROUP" ;;
    *) die "Usage: scripts/ota.sh join <Dev|Prod> <thing> <sketch> [canary|internal]" ;;
  esac
  aws_whoami
  assert_aws_environment "$env"
  for group in $groups; do
    [ "$group" = "$target" ] && continue
    aws iot remove-thing-from-thing-group --thing-name "$thing" --thing-group-name "$group" > /dev/null 2>&1 || true
  done
  aws iot add-thing-to-thing-group --thing-name "$thing" --thing-group-name "$target"
  note "$thing is in $target."
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
  try)     cmd_try "$env" "$@" ;;
  promote) cmd_promote "$env" "$@" ;;
  join)    cmd_join "$env" "$@" ;;
  status)  cmd_status "$env" ;;
  interval) cmd_interval "$env" "$@" ;;
  *)       usage ;;
esac
