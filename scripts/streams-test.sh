#!/usr/bin/env bash
#
# streams-test.sh - send one synthetic vitals reading down the chapter 02 stream.
#
#   scripts/streams-test.sh <Dev|Prod> <device> [critical|warning|normal]
#
# The boards send only temperature and humidity (from a DHT11, which is not
# a clinical instrument), so nothing they send ever reaches a clinical band
# and the stream never fires on its own. This puts one reading
# with a heart rate and an SpO2 on it, the way a wearable would:
#
#   event-router -> patient-vitals-event-bus -> alert-dispatcher
#     -> StreamingAlertService (Salesforce) -> Patient_Vital_Alert__e
#     -> VitalAlertCaseService: a "Critical vitals on <device>" Case
#
# critical (the default) opens that Case in the care team's queue, once per
# device while it stays open. warning publishes an ABNORMAL_TREND alert and
# opens nothing. normal is judged and dropped in AWS. Nothing is written to
# Patient_Vitals__c and no board is contacted: the reading is labelled
# SYNTHETIC_TEST in the AWS logs so it cannot be taken for a measured one.
#
# The device must be a Monitoring Device Asset (API name Patient_Device;
# its serial number is its Thing name). The script prints what the dispatcher decided, from its log.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

usage() { sed -n '3,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

env="${1:-}"; device="${2:-}"; level="${3:-critical}"
check_environment "$env"
[ -n "$device" ] || usage
[[ "$device" =~ ^[A-Za-z0-9_:-]{1,128}$ ]] || die "'$device' is not a Thing name."
refuse_local_prod "$env" "A synthetic reading opens a real Case. Send it to Dev."

case "$level" in
  critical) vitals='"heartRate":135,"spo2":86,"temperature":37.0' ;;
  warning)  vitals='"heartRate":105,"spo2":94,"temperature":37.0' ;;
  normal)   vitals='"heartRate":75,"spo2":98,"temperature":36.8' ;;
  *) usage ;;
esac

need jq "Install jq."
aws_whoami
assert_aws_environment "$env"

router="$PROJECT-event-router"
dispatcher="$PROJECT-alert-dispatcher"
aws lambda get-function --function-name "$router" > /dev/null 2>&1 \
  || die "$router is not in this account. Deploy the streaming stack first: scripts/deploy-aws.sh $env"

payload=$(mktemp); out=$(mktemp)
trap 'rm -f "$payload" "$out"' EXIT
printf '{"deviceId":"%s",%s,"sourceSystem":"SYNTHETIC_TEST"}' "$device" "$vitals" > "$payload"
started=$(( $(date +%s) * 1000 ))

step "Send a $level reading for $device to the stream"
aws lambda invoke --function-name "$router" --cli-binary-format raw-in-base64-out \
  --payload "fileb://$payload" "$out" > /dev/null
jq -r '.body // .' "$out"
jq -e '.statusCode == 200' "$out" > /dev/null || die "The event router refused the reading (above)."
endstep

step "What the alert dispatcher decided"
found=""
for _ in $(seq 1 12); do
  sleep 5
  found=$(aws logs filter-log-events --log-group-name "/aws/lambda/$dispatcher" \
            --start-time "$started" --filter-pattern "\"$device\"" \
            --query 'events[].message' --output text 2>/dev/null || true)
  [ -n "$found" ] && break
done
[ -n "$found" ] || die "Nothing from $dispatcher about $device in a minute. Check the rule on patient-vitals-event-bus and the dispatcher's log group."
printf '%s\n' "$found" | tr '\t' '\n' | grep -v '^\(START\|END\|REPORT\) ' || true
endstep

case "$level" in
  critical) note "In Salesforce: Cases, Care Team Queue, 'Critical vitals on $device' (Origin Vital Alert). A second run opens nothing while it is open." ;;
  warning)  note "An ABNORMAL_TREND alert was published; it opens no Case by design." ;;
  normal)   note "No alert: the reading is inside every band." ;;
esac
