#!/usr/bin/env bash
#
# check.sh - catch on your laptop what would otherwise fail in a deploy.
#
#   scripts/check.sh                  every part
#   scripts/check.sh lambda firmware  only the parts named
#
# Parts: lambda, templates, scripts, salesforce, firmware. The pull request
# checks (.github/workflows/checks.yml) run these same parts, so green here
# means green on the PR. Nothing here needs credentials: no AWS account, no
# org, no board.
#
# On a laptop, a part whose tool is not installed is skipped with a warning, so
# you can start with Node alone. In CI a missing tool is an error: a check that
# quietly did not run is worse than no check at all.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
cd "$REPO_ROOT"

PARTS="lambda templates scripts salesforce firmware"
SKIPPED=""

has() { command -v "$1" > /dev/null 2>&1; }

# skip <tool> <part> <how to install>
skip() {
  in_ci && die "$1 is not installed on this runner, so the $2 check cannot run."
  warn "Skipped $2: $1 is not installed ($3)."
  SKIPPED="$SKIPPED $2"
}

check_lambda() {
  has node || { skip node lambda "https://nodejs.org, version 22"; return 0; }
  step "Lambda: syntax of every source file, then the unit tests"
  # The syntax pass catches a typo in a function that has no tests yet.
  find lambda -name '*.js' -not -path '*/node_modules/*' -print0 | xargs -0 -n1 node --check
  npm test --silent
  endstep
}

check_templates() {
  has cfn-lint || { skip cfn-lint templates "pip install cfn-lint"; return 0; }
  step "CloudFormation: lint every template"
  # Errors fail the check. Warnings, such as a runtime nearing its end of
  # support, are printed but do not.
  find . -name cloudformation.yaml -not -path '*/node_modules/*' -print0 \
    | xargs -0 cfn-lint --non-zero-exit-code error --

  # Every sketch needs its two groups in the ota stack, or its releases have
  # nowhere to go. A new sketch without them fails here, not on a board.
  local sketch group
  for sketch in $(sketches); do
    for group in "fleet-$sketch" "canary-$sketch"; do
      grep -q "ThingGroupName: $group\$" infra/ota/cloudformation.yaml \
        || die "infra/ota/cloudformation.yaml declares no Thing Group $group, so firmware/$sketch could never be released."
    done
  done
  endstep
}

check_scripts() {
  has shellcheck || { skip shellcheck scripts "brew install shellcheck"; return 0; }
  step "Shell scripts: shellcheck"
  shellcheck --external-sources --severity=warning scripts/*.sh scripts/lib/*.sh
  endstep
}

check_salesforce() {
  has sf || { skip sf salesforce "npm install --global @salesforce/cli"; return 0; }
  step "Salesforce: resolve every metadata file, offline"
  # Converting to Metadata API format resolves each file's type the way a
  # deploy does, so a misplaced file, a missing -meta.xml or a wrong bundle
  # layout fails here, with no org involved.
  local out
  out=$(mktemp -d)
  sf project convert source --output-dir "$out/mdapi" > /dev/null
  rm -rf "$out"
  endstep
}

check_firmware() {
  has arduino-cli || { skip arduino-cli firmware "brew install arduino-cli, then scripts/firmware.sh setup"; return 0; }
  scripts/firmware.sh build
  # The pull request checks compare with the PR's base branch. Locally,
  # compare with Dev when it has been fetched.
  if ! in_ci && git rev-parse --verify --quiet origin/Dev > /dev/null; then
    scripts/firmware.sh check-version origin/Dev
  fi
}

selected="${*:-$PARTS}"
for part in $selected; do
  case " $PARTS " in
    *" $part "*) "check_$part" ;;
    *) die "No part called '$part'. Parts: $PARTS" ;;
  esac
done

if [ -n "$SKIPPED" ]; then
  warn "Passed, but these were not checked:$SKIPPED. The pull request checks run them."
else
  echo "All checks passed."
fi
