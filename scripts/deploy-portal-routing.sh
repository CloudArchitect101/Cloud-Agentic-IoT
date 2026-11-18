#!/usr/bin/env bash
#
# deploy-portal-routing.sh - route the patient portal's Enhanced Chat to the
# Patient Portal Agent, with Care_Team_Queue as the fallback.
#
#   scripts/deploy-portal-routing.sh <org alias> [--dry-run]
#
# The Omni-Channel flow's Route Work action stores org-specific Ids (the
# agent, the Messaging service channel, the queue), so the flow lives in
# salesforce-templates/portal-routing with placeholders. This script looks
# the Ids up by name, fills them into a temporary copy, and deploys the flow
# with Care_Team_Queue (which must accept Messaging Sessions). Run it after
# scripts/publish-portal-agent.sh, then set the channel's Routing Type to
# Omni-Flow with this flow (docs/PATIENT-PORTAL.md, step 7).

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ORG="${1:-${SF_TARGET_ORG:-}}"
[ -n "$ORG" ] || die "Name the org: scripts/deploy-portal-routing.sh <org alias> [--dry-run]"
DRY=""
[ "${2:-}" = "--dry-run" ] && DRY="--dry-run"
need sf "Install the Salesforce CLI - see docs/SETUP.md."
need jq "It reads the CLI's JSON output."
cd "$REPO_ROOT"

id_of() {   # id_of <label> <SOQL>
  local id
  id=$(sf data query --target-org "$ORG" --query "$2" --json 2>/dev/null | jq -r '.result.records[0].Id // empty')
  [ -n "$id" ] || die "$1 not found in $ORG ($2)."
  printf '%s' "$id"
}

step "Look up the Ids in $ORG"
bot=$(id_of "The Patient Portal Agent (publish it first: scripts/publish-portal-agent.sh)" \
  "SELECT Id FROM BotDefinition WHERE DeveloperName = 'Patient_Portal_Agent'")
channel=$(id_of "The Messaging service channel (turn on Messaging)" \
  "SELECT Id FROM ServiceChannel WHERE DeveloperName = 'sfdc_livemessage'")
queue=$(id_of "Care_Team_Queue" \
  "SELECT Id FROM Group WHERE Type = 'Queue' AND DeveloperName = 'Care_Team_Queue'")
note "agent $bot, channel $channel, queue $queue"
endstep

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/flows" "$work/queues" "$work/queueRoutingConfigs"
sed -e "s/__BOT_ID__/$bot/" -e "s/__SERVICE_CHANNEL_ID__/$channel/" -e "s/__QUEUE_ID__/$queue/" \
  salesforce-templates/portal-routing/Route_Patient_Portal_Chat.flow > "$work/flows/Route_Patient_Portal_Chat.flow"
cp force-app/main/default/queues/Care_Team_Queue.queue-meta.xml "$work/queues/Care_Team_Queue.queue"
cp force-app/main/default/queueRoutingConfigs/Care_Team_Chat.queueRoutingConfig-meta.xml \
  "$work/queueRoutingConfigs/Care_Team_Chat.queueRoutingConfig"
cat > "$work/package.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types><members>Route_Patient_Portal_Chat</members><name>Flow</name></types>
    <types><members>Care_Team_Queue</members><name>Queue</name></types>
    <types><members>Care_Team_Chat</members><name>QueueRoutingConfig</name></types>
    <version>67.0</version>
</Package>
XML

step "Deploy the routing flow and the queue to $ORG${DRY:+ (dry run)}"
# shellcheck disable=SC2086  # DRY is empty or one flag
sf project deploy start --metadata-dir "$work" --target-org "$ORG" --test-level NoTestRun --wait 10 $DRY
endstep

note "Next: Messaging Settings > Patient Portal Chat > Routing Type Omni-Flow, Flow Route_Patient_Portal_Chat, Fallback Queue Care Team Queue."
