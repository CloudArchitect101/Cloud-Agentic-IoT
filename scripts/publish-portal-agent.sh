#!/usr/bin/env bash
#
# publish-portal-agent.sh - compile and publish the patient portal's agent,
# written in Agent Script (force-app/main/default/aiAuthoringBundles/
# Patient_Portal_Agent), to an org.
#
#   PORTAL_AGENT_USER=<agent user's username> scripts/publish-portal-agent.sh <org alias>
#
# The agent is built in the new Agentforce Builder format, so it is published,
# not deployed: Salesforce compiles the script, creates the agent (or a new
# version of it) with its Bot, BotVersion and planner, then stores the bundle.
# scripts/deploy-salesforce.sh leaves aiAuthoringBundles/ out for that reason.
#
# The agent user is org-specific (a username), so the repo holds a placeholder
# and this script fills it in for the publish only, then puts the file back.
# Run scripts/deploy-salesforce.sh first: the actions call Apex that deploy
# ships (MyDevicesAgentAction, RequestNurseAgentAction).

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ORG="${1:-${SF_TARGET_ORG:-}}"
[ -n "$ORG" ] || die "Name the org: scripts/publish-portal-agent.sh <org alias>"
[ -n "${PORTAL_AGENT_USER:-}" ] || die "Set PORTAL_AGENT_USER to the agent user's username (docs/PATIENT-PORTAL.md, step 7)."
need sf "Install the Salesforce CLI - see docs/SETUP.md."
cd "$REPO_ROOT"

BUNDLE=Patient_Portal_Agent
SCRIPT="force-app/main/default/aiAuthoringBundles/$BUNDLE/$BUNDLE.agent"
PLACEHOLDER='default_agent_user: "PORTAL_AGENT_USER"'
grep -qF "$PLACEHOLDER" "$SCRIPT" || die "$SCRIPT has no agent user placeholder; restore it with git checkout -- $SCRIPT"

# The publish (or validate) rewrites files under force-app: the bundle's
# -meta.xml, reformatted genAiFunctions and, without --skip-retrieve, bots/
# and genAiPlannerBundles/. Left there, they make the next
# scripts/deploy-salesforce.sh refuse an uncommitted tree. So this script
# refuses a dirty force-app and puts force-app back to the commit on exit,
# which also restores the agent user placeholder filled in below.
if [ -n "$(git status --porcelain -- force-app)" ]; then
  git status --short -- force-app >&2
  die "force-app has uncommitted changes. Commit or stash them first: after publishing, this script resets force-app to the commit."
fi
restore() {
  git checkout -- force-app
  git clean -fdq -- force-app
}
trap restore EXIT
PORTAL_AGENT_USER="$PORTAL_AGENT_USER" node -e '
  const fs = require("fs"); const f = process.argv[1];
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(process.argv[2], `default_agent_user: ${JSON.stringify(process.env.PORTAL_AGENT_USER)}`));
' "$SCRIPT" "$PLACEHOLDER"

step "Compile $BUNDLE"
sf agent validate authoring-bundle --api-name "$BUNDLE" --target-org "$ORG"
endstep

# --skip-retrieve: the generated Bot, BotVersion and planner stay in the org;
# the Agent Script file is the source of truth here.
step "Publish $BUNDLE to $ORG"
sf agent publish authoring-bundle --api-name "$BUNDLE" --target-org "$ORG" --skip-retrieve
endstep

note "Published. Activate it in Agentforce Builder (or: sf agent activate --api-name $BUNDLE --target-org $ORG), then connect it to the Enhanced Chat deployment."
