#!/usr/bin/env bash
#
# data-cloud-insights.sh - create the calculated insights in
# datacloud/calculated-insights.json in one org's Data Cloud.
#
#   SF_TARGET_ORG=<admin alias> scripts/data-cloud-insights.sh            create them
#   SF_TARGET_ORG=<admin alias> scripts/data-cloud-insights.sh --dry-run  print each request, send nothing
#
# The Metadata API has a type for a calculated insight, but Salesforce
# documents moving Data Cloud configuration through data kits, which are
# built in an org first. A calculated insight is also one Connect REST API
# call, POST /services/data/v<version>/ssot/calculated-insights with its SQL,
# so this sends that, as whoever SF_TARGET_ORG signs in as: an admin with Data
# Cloud, not the deploy user. The SQL is the file in datacloud/, as it is.
#
# Run it after the Room_Reading data model object exists and has data
# (docs/DATA-CLOUD.md): Data Cloud checks the SQL against it and refuses an
# insight over fields it does not have. An insight that exists already is
# left as it is: change it in Data Cloud, or delete it there and run this
# again. Nothing here touches AWS.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true
need sf "Install the Salesforce CLI - see docs/SETUP.md."
need node "It reads datacloud/calculated-insights.json."
cd "$REPO_ROOT"

org="${SF_TARGET_ORG:-}"
[ -n "$org" ] || die "Set SF_TARGET_ORG to the alias of an admin of the org whose Data Cloud gets the insights."
version=$(node -p "require('./sfdx-project.json').sourceApiVersion")
base="/services/data/v$version/ssot/calculated-insights"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# One request body per insight, written as JSON by Node so the SQL's quotes
# and line breaks are escaped the way JSON wants. Prints each apiName. The
# program goes to a file first: macOS's bash 3.2 misreads a here-document
# inside $( ) that holds an apostrophe.
cat > "$work/bodies.js" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const [work] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync('datacloud/calculated-insights.json', 'utf8'));
for (const insight of manifest.insights) {
  if (!/^[A-Za-z][A-Za-z0-9_]*__cio$/.test(insight.apiName)) {
    throw new Error(`${insight.apiName}: a calculated insight's API name is letters, digits and _, ending __cio`);
  }
  // Data Cloud refuses a new insight without a publish schedule
  // (REQUIRED_FIELD_MISSING publishScheduleInterval). Only the hourly ones
  // are accepted here: NotScheduled would leave the insight never running.
  const intervals = ['One', 'Six', 'Twelve', 'TwentyFour'];
  if (!intervals.includes(insight.publishScheduleInterval)) {
    throw new Error(`${insight.apiName}: publishScheduleInterval must be one of ${intervals.join(', ')}`);
  }
  const expression = fs.readFileSync(path.join('datacloud', insight.sql), 'utf8').trim();
  const body = {
    apiName: insight.apiName,
    displayName: insight.displayName,
    description: insight.description,
    definitionType: 'CalculatedMetric',
    publishScheduleInterval: insight.publishScheduleInterval,
    expression,
  };
  fs.writeFileSync(path.join(work, `${insight.apiName}.json`), JSON.stringify(body, null, 2));
  console.log(insight.apiName);
}
EOF
names=$(node "$work/bodies.js" "$work")

# answered_with_api_name <response file> <apiName>: whether the response is
# the insight itself. An error comes back as a list of errors instead, and
# whether sf exits non-zero for one is not something to rely on.
answered_with_api_name() {
  node -e '
    const fs = require("node:fs");
    let body;
    try { body = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(1); }
    process.exit(body && !Array.isArray(body) && body.apiName === process.argv[2] ? 0 : 1);
  ' "$1" "$2"
}

created=0 kept=0 failed=""
for api in $names; do
  step "$api"
  if [ "$DRY_RUN" = true ]; then
    echo "POST $base"
    cat "$work/$api.json"
    echo
    endstep
    continue
  fi
  sf api request rest "$base/$api" --target-org "$org" > "$work/$api.get" 2>&1 || true
  if answered_with_api_name "$work/$api.get" "$api"; then
    echo "  exists already: left as it is"
    kept=$((kept + 1))
    endstep
    continue
  fi
  sf api request rest "$base" --method POST --header 'Content-Type: application/json' \
    --body "@$work/$api.json" --target-org "$org" > "$work/$api.post" 2>&1 || true
  if answered_with_api_name "$work/$api.post" "$api"; then
    echo "  created"
    created=$((created + 1))
  else
    cat "$work/$api.post" >&2
    failed="$failed $api"
  fi
  endstep
done

if [ "$DRY_RUN" = true ]; then
  note "Dry run: nothing sent to $org."
  exit 0
fi
[ -z "$failed" ] || die "Data Cloud did not take:$failed (its answer is above). Check that Room_Reading has the fields the SQL names, or paste the SQL into Data Cloud's calculated insight builder, whose Check Syntax names the problem."
note "Calculated insights in $org: $created created, $kept already there."
