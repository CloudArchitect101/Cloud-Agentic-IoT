#!/usr/bin/env bash
#
# set-portal-chat-url.sh - tell one org where its Enhanced Chat site is.
#
#   scripts/set-portal-chat-url.sh <org alias> <chat site URL> [--dry-run]
#   scripts/set-portal-chat-url.sh iot-dev-admin https://example.my.site.com/ESWPatientPortalChat1700000000000
#
# The chat site URL differs in every org, so it is not in force-app: a deploy
# sets every field a record names, and one org's URL would land in all the
# others. This script deploys a copy of Patient_Portal_Setting.Default that
# names only Chat_Site_Url__c. A field a deploy does not name keeps the org's
# value, so the other settings stay as they are, and later deploys from
# force-app (which does not name this field) keep the URL.
#
# Run it once per org, after the Enhanced Chat deployment exists
# (docs/INSTALL.md, step 10). The URL is in the deployment's code snippet and
# holds "ESW". It is not a secret.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ORG="${1:-}"
URL="${2:-}"
DRY=""
[ "${3:-}" = "--dry-run" ] && DRY="--dry-run"
[ -n "$ORG" ] && [ -n "$URL" ] \
  || die "Usage: scripts/set-portal-chat-url.sh <org alias> <chat site URL> [--dry-run]"
# https, a host, a path that holds ESW, and nothing XML would have to escape.
[[ "$URL" =~ ^https://[A-Za-z0-9.-]+/[A-Za-z0-9_/-]*ESW[A-Za-z0-9_/-]*$ ]] \
  || die "That does not look like a chat site URL. Copy it from the Embedded Service deployment's code snippet: it starts with https:// and its path holds ESW."
URL="${URL%/}"
need sf "Install the Salesforce CLI - see docs/SETUP.md."
cd "$REPO_ROOT"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/customMetadata"
cat > "$work/customMetadata/Patient_Portal_Setting.Default.md" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <label>Default</label>
    <protected>false</protected>
    <values>
        <field>Chat_Site_Url__c</field>
        <value xsi:type="xsd:string">$URL</value>
    </values>
</CustomMetadata>
XML
cat > "$work/package.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types><members>Patient_Portal_Setting.Default</members><name>CustomMetadata</name></types>
    <version>67.0</version>
</Package>
XML

step "Set the chat site URL in $ORG${DRY:+ (dry run)}"
# shellcheck disable=SC2086  # DRY is empty or one flag
sf project deploy start --metadata-dir "$work" --target-org "$ORG" --test-level NoTestRun --wait 10 $DRY
endstep

note "Reload the portal: the chat button opens the care assistant. Later deploys keep this URL."
