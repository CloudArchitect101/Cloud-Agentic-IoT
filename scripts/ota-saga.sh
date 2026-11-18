#!/usr/bin/env bash
#
# ota-saga.sh - update one board through the OTA saga (chapter 09).
#
#   scripts/ota-saga.sh send <Dev|Prod> <thing> <sketch> <version>   start a saga
#   scripts/ota-saga.sh status <Dev|Prod> <thing>                    where the board's sagas got to
#
# send puts one message on cloud-agentic-iot-ota-saga. The ota-saga function
# then stages the build, marks the Thing otaState=UPDATING, makes one IoT Job
# for that board and looks at it once a minute: SUCCEEDED marks the Thing
# ACTIVE at the new version; FAILED, REJECTED, TIMED_OUT or no answer within
# its attempts cancels the job, marks the Thing ACTIVE again and deletes the
# staged copy, in that order. The build must be published already, by a
# release (firmware/<sketch>/<version>.bin) or a try
# (firmware/<sketch>/try/<version>.bin, scripts/ota.sh try).
#
# To watch a rollback, turn the board off first: its job stays QUEUED, and
# once the attempts run out (20 minutes by default) the saga unwinds.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

usage() { sed -n '3,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

cmd="${1:-}"; env="${2:-}"; thing="${3:-}"
[ -n "$cmd" ] || usage
check_environment "$env"
[[ "$thing" =~ ^[A-Za-z0-9_:-]{1,128}$ ]] || die "'$thing' is not a Thing name."

need jq "Install jq."
aws_whoami
assert_aws_environment "$env"
SAGA_STACK=$(stack_name ota-saga "$env")
OTA_STACK=$(stack_name ota "$env")

cmd_send() {
  local sketch="$1" version="$2" bucket queue key run_id body
  [[ "$sketch" =~ ^[A-Za-z0-9_-]{1,40}$ ]] || die "'$sketch' is not a sketch name."
  [[ "$version" =~ ^[0-9A-Za-z.+-]{1,40}$ ]] || die "'$version' is not a firmware version."
  refuse_local_prod "$env" "Prod boards are updated by releases and promotion (scripts/ota.sh)."
  queue=$(stack_output "$SAGA_STACK" SagaQueueUrl)
  [ -n "$queue" ] && [ "$queue" != None ] || die "No $SAGA_STACK stack. Deploy it first: scripts/deploy-aws.sh $env"
  bucket=$(stack_output "$OTA_STACK" FirmwareBucketName)
  key=""
  for candidate in "firmware/$sketch/$version.bin" "firmware/$sketch/try/$version.bin"; do
    if aws s3api head-object --bucket "$bucket" --key "$candidate" > /dev/null 2>&1; then key="$candidate"; break; fi
  done
  [ -n "$key" ] || die "No published $sketch $version in $bucket. Publish it with scripts/ota.sh try $env $sketch, or name a released version."
  aws iot describe-thing --thing-name "$thing" > /dev/null 2>&1 || die "No Thing named $thing in this account."

  run_id="$(date -u +%Y%m%d%H%M%S)"
  body=$(jq -cn --arg d "$thing" --arg s "$sketch" --arg v "$version" --arg r "$run_id" --arg k "$key" \
           '{deviceId: $d, sketch: $s, version: $v, runId: $r, firmwareKey: $k}')
  step "Saga $run_id: $sketch $version to $thing"
  aws sqs send-message --queue-url "$queue" --message-body "$body" > /dev/null
  endstep
  note "Job saga-$thing-$run_id. Follow it: aws logs tail /aws/lambda/$PROJECT-ota-saga --follow, or scripts/ota-saga.sh status $env $thing"
}

cmd_status() {
  step "$thing"
  aws iot describe-thing --thing-name "$thing" \
    --query '{otaState: attributes.otaState, otaVersion: attributes.otaVersion}' --output table
  aws iot list-job-executions-for-thing --thing-name "$thing" --max-results 10 \
    --query "executionSummaries[?starts_with(jobId, 'saga-')].[jobId, jobExecutionSummary.status]" --output table
  endstep
}

shift 3
case "$cmd" in
  send)   [ $# -eq 2 ] || usage; cmd_send "$@" ;;
  status) [ $# -eq 0 ] || usage; cmd_status ;;
  *)      usage ;;
esac
