#!/usr/bin/env bash
#
# bootstrap-salesforce.sh - the one-time Salesforce setup an admin would
# otherwise click through: it creates, with placeholder values, the pieces in
# bootstrap/salesforce/ that the org does not have yet.
#
#   scripts/bootstrap-salesforce.sh <org alias> [--url <URL>] [--region <Region>] [--dry-run]
#   scripts/bootstrap-salesforce.sh iot-dev-admin
#
# What it creates, each only when the org has none by that name:
#   - external credential AWS_IoT_Relay (AWS Signature Version 4, through STS)
#   - named credential    AWS_IoT_Relay
#   - permission set      AWS_IoT_Relay_Callers (access to the credential)
#
# It never changes a piece that exists. A deploy sets every value a file
# names, so deploying these over a working org would put the placeholders
# back in place of the URL and Region an admin set. That is also why they
# live in bootstrap/, not force-app/: the pipeline deploys force-app/ on
# every merge and must never see them. The script refuses to run in the
# pipeline, and when it cannot tell whether a piece exists it stops instead
# of deploying.
#
# The two options replace placeholders with values that are not secret:
# install.sh prints the URL ("Step 7c"). Leave them out and the placeholders
# go in, for you to change in Setup.
#
# Three values are never an option, a file or an environment variable,
# because Salesforce keeps them as stored credentials, not as metadata: the
# access key, its secret, and the principal's IAM Role ARN. You type them in
# Setup (docs/INSTALL.md, step 7b).
#
# Run it as an admin, once per org, after the first deploy (step 6).

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

USAGE="Usage: scripts/bootstrap-salesforce.sh <org alias> [--url <URL>] [--region <Region>] [--dry-run]"
SRC="bootstrap/salesforce"
CREDENTIAL=AWS_IoT_Relay
CALLERS=AWS_IoT_Relay_Callers
# The placeholders, exactly as the files in bootstrap/salesforce/ spell them
# (test/config/bootstrap-placeholders.test.js keeps the two in step).
DUMMY_URL='https://dummy-replace-me.example.com'
DUMMY_REGION='us-east-1'

in_ci && die "bootstrap-salesforce.sh is one-time setup an admin runs by hand. The pipeline deploys force-app/ only."

ORG="${1:-}"
[ -n "$ORG" ] && [ "${ORG#--}" = "$ORG" ] || die "$USAGE"
shift
URL=""; REGION=""; DRY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url)      URL="${2:-}";    [ -n "$URL" ]    || die "$USAGE"; shift 2 ;;
    --region)   REGION="${2:-}"; [ -n "$REGION" ] || die "$USAGE"; shift 2 ;;
    --dry-run)  DRY="--dry-run"; shift ;;
    *) die "Unknown option $1. $USAGE" ;;
  esac
done
# Checked strictly: the values go into XML and into sed, so nothing that
# either would have to escape gets through.
if [ -n "$URL" ]; then
  [[ "$URL" =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9_/-]*)?$ ]] \
    || die "--url must be the API's https URL (install.sh prints it as \"Step 7c\")."
  URL="${URL%/}"
fi
if [ -n "$REGION" ]; then
  [[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || die "--region must be an AWS Region such as us-east-2."
fi
need sf "Install the Salesforce CLI - see docs/SETUP.md."
need jq "It reads the CLI's JSON output."
cd "$REPO_ROOT"

# has <what> <SOQL>: true when the org has a row. A failed or unreadable
# query stops the script: guessing "missing" could overwrite a working piece.
has() {
  local out n
  out=$(sf data query --target-org "$ORG" --json --query "$2" 2>/dev/null) \
    || die "Could not ask $ORG whether it has $1, so nothing was deployed. Is the alias right and are you signed in (sf org display --target-org $ORG)?"
  n=$(printf '%s' "$out" | jq -r '.result.totalSize // empty' 2>/dev/null) || n=""
  [[ "$n" =~ ^[0-9]+$ ]] || die "Could not read $ORG's answer about $1, so nothing was deployed."
  [ "$n" != "0" ]
}

step "What $ORG already has"
deploy_external=false; deploy_named=false; deploy_callers=false
has_external=false
if has "the external credential $CREDENTIAL" "SELECT Id FROM ExternalCredential WHERE DeveloperName = '$CREDENTIAL'"; then
  has_external=true
fi
if has "the named credential $CREDENTIAL" "SELECT Id FROM NamedCredential WHERE DeveloperName = '$CREDENTIAL'"; then
  # A named credential that works may sit on an external credential of any
  # name, so neither is touched.
  echo "  named credential $CREDENTIAL: exists, left as it is (with its external credential)"
else
  deploy_named=true
  echo "  named credential $CREDENTIAL: missing, will be created"
  if [ "$has_external" = true ]; then
    echo "  external credential $CREDENTIAL: exists, left as it is"
  else
    deploy_external=true
    echo "  external credential $CREDENTIAL: missing, will be created"
  fi
fi
if has "the permission set $CALLERS" "SELECT Id FROM PermissionSet WHERE Name = '$CALLERS'"; then
  echo "  permission set $CALLERS: exists, left as it is"
elif [ "$has_external" = true ] || [ "$deploy_external" = true ]; then
  deploy_callers=true
  echo "  permission set $CALLERS: missing, will be created"
else
  # The set names the principal of an external credential called AWS_IoT_Relay;
  # this org's has another name, so the set would not deploy.
  warn "$ORG has no permission set $CALLERS, and its external credential is not named $CREDENTIAL, so the set was not created. Make it in Setup (docs/INSTALL.md, step 7d)."
fi
endstep

if [ "$deploy_external" = false ] && [ "$deploy_named" = false ] && [ "$deploy_callers" = false ]; then
  note "$ORG already has everything in $SRC that could be created. Nothing was changed."
  exit 0
fi

# The Metadata API layout: one folder per type, files without -meta.xml.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stage() {  # stage <folder> <name> <suffix>
  mkdir -p "$work/$1"
  sed -e "s|$DUMMY_URL|${URL:-$DUMMY_URL}|g" \
      -e "s|>$DUMMY_REGION<|>${REGION:-$DUMMY_REGION}<|g" \
      "$SRC/$1/$2.$3-meta.xml" > "$work/$1/$2.$3"
}
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<Package xmlns="http://soap.sforce.com/2006/04/metadata">'
  if [ "$deploy_external" = true ]; then
    stage externalCredentials "$CREDENTIAL" externalCredential
    echo "    <types><members>$CREDENTIAL</members><name>ExternalCredential</name></types>"
  fi
  if [ "$deploy_named" = true ]; then
    stage namedCredentials "$CREDENTIAL" namedCredential
    echo "    <types><members>$CREDENTIAL</members><name>NamedCredential</name></types>"
  fi
  if [ "$deploy_callers" = true ]; then
    stage permissionsets "$CALLERS" permissionset
    echo "    <types><members>$CALLERS</members><name>PermissionSet</name></types>"
  fi
  echo '    <version>67.0</version>'
  echo '</Package>'
} > "$work/package.xml"

step "Create the missing pieces in $ORG${DRY:+ (dry run)}"
# shellcheck disable=SC2086  # DRY is empty or one flag
sf project deploy start --metadata-dir "$work" --target-org "$ORG" --test-level NoTestRun --wait 10 $DRY
endstep

if [ -n "$DRY" ]; then
  note "Dry run: $ORG was not changed."
  exit 0
fi

note "Created in $ORG. What is left for you, in Setup -> Named Credentials (docs/INSTALL.md, step 7):"
if [ "$deploy_external" = true ]; then
  echo "  - External Credentials -> $CREDENTIAL: type the STS Access Key and STS Access Secret (step 7a prints them once)."
  echo "  - External Credentials -> $CREDENTIAL -> principal Caller: type the IAM Role ARN that install.sh printed as \"Step 7b\" (it has :role/ in it)."
  if [ -z "$REGION" ]; then
    echo "  - External Credentials -> $CREDENTIAL: set the Region if yours is not $DUMMY_REGION."
  fi
fi
if [ "$deploy_named" = true ] && [ -z "$URL" ]; then
  echo "  - Named Credentials -> $CREDENTIAL: replace the URL $DUMMY_URL with the one install.sh printed as \"Step 7c\"."
fi
echo "  - Assign $CALLERS to the integration user, and to each care team member (step 7d)."
note "Running this again is safe: it creates only what is missing and never changes what exists."
