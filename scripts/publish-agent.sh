#!/usr/bin/env bash
#
# publish-agent.sh - publish an Agent Script agent and activate its newest
# version, leaving the checkout as it was.
#
#   SF_TARGET_ORG=test-yourname scripts/publish-agent.sh Dev [Patient_Care_Agent]
#
# Run it after scripts/deploy-salesforce.sh, which deploys the actions the
# agent calls. `sf agent publish authoring-bundle` writes what Salesforce
# generated back into force-app: a bots/ and a genAiPlannerBundles/ folder
# (legacy-builder metadata this repo never keeps) and reformatted copies of
# the genAiFunctions and the bundle-meta. Left there, they make the next
# laptop deploy refuse an uncommitted tree. So this script refuses to start
# on a tree with changes under force-app, and after publishing puts force-app
# back to the commit. docs/TROUBLESHOOTING.md has the story.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ENV="${1:-}"
AGENT="${2:-Patient_Care_Agent}"
check_environment "$ENV"
refuse_local_prod "$ENV"
need sf "It publishes the agent."
cd "$REPO_ROOT"
org="${SF_TARGET_ORG:-iot-$(tr '[:upper:]' '[:lower:]' <<< "$ENV")-deploy}"

if [ -n "$(git status --porcelain -- force-app)" ]; then
  git status --short -- force-app >&2
  die "force-app has uncommitted changes. Commit or stash them first: after publishing, this script resets force-app to the commit."
fi

restore() {
  git checkout -- force-app
  git clean -fdq -- force-app
}
trap restore EXIT

step "Publish $AGENT to $org"
sf agent deactivate --api-name "$AGENT" --target-org "$org" >/dev/null 2>&1 || true
sf agent publish authoring-bundle --api-name "$AGENT" --target-org "$org"
sf agent activate --api-name "$AGENT" --target-org "$org" --json
endstep
