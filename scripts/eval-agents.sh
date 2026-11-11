#!/usr/bin/env bash
#
# eval-agents.sh - run the agent evals against a real org and account.
#
#   SF_TARGET_ORG=test-cloudarchitect101 AWS_PROFILE=test-cloudarchitect101 scripts/eval-agents.sh Dev
#   scripts/eval-agents.sh Dev retrieval     only the Bedrock SOP retrieval eval (AWS only)
#   scripts/eval-agents.sh Dev agents        only the Agentforce Testing Center tests (Salesforce only)
#
# Two kinds of eval, both reported as JUnit XML in test-results/evals:
#
#  retrieval  every question in test/agents/sop-retrieval-cases.json goes to
#             the deployed procedure-search function, so real Titan V2
#             embeddings search the real index. scripts/lib/sop-retrieval-eval.js
#             scores hit@1, hit@3 and MRR and fails under the thresholds.
#  agents     each test/agents/*-testSpec.yaml is filled in for this org
#             (scripts/lib/agent-spec.js), created as an AiEvaluationDefinition
#             with `sf agent test create`, and run with `sf agent test run`.
#             Testing Center checks the subagent, the actions and the reply.
#
# Unlike scripts/check.sh this costs a little and changes a little: Bedrock
# embeds ~15 questions (a fraction of a cent), the agent tests use Agentforce
# requests (Flex Credits in a paid org), and the two confirmed-request cases
# open Cases, which this script closes again at the end. docs/AGENT-EVALS.md
# explains each test and how to read the results.
#
# Settings (environment):
#   EVAL_DEVICE             the staff agent's demo device              (Test8)
#   EVAL_OTHER_DEVICE       a device that is not the test patient's    (Test7)
#   EVAL_PATIENT_USERNAME   the portal patient whose verified chat to use
#                           (default: the newest verified portal chat)

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ENV="${1:-}"
PART="${2:-all}"
check_environment "$ENV"
refuse_local_prod "$ENV"
case "$PART" in all|retrieval|agents) ;; *) die "Unknown part '$PART'. Use all, retrieval or agents." ;; esac
need node "It fills in the specs and scores the results."
cd "$REPO_ROOT"

org="${SF_TARGET_ORG:-iot-$(tr '[:upper:]' '[:lower:]' <<< "$ENV")-deploy}"
DEVICE="${EVAL_DEVICE:-Test8}"
OTHER_DEVICE="${EVAL_OTHER_DEVICE:-Test7}"
OUT="test-results/evals"
SUMMARY="${GITHUB_STEP_SUMMARY:-$OUT/summary.md}"
rm -rf "$OUT"
mkdir -p "$OUT"
: > "$OUT/summary.md"
work=$(mktemp -d)
failed=""

cleanup() {
  rm -rf "$work"
  # `sf agent test create` retrieves the AiEvaluationDefinition it deployed
  # into force-app. It is generated from the spec, so it is not kept.
  rm -rf force-app/main/default/aiEvaluationDefinitions
}
trap cleanup EXIT

# --- Bedrock: SOP retrieval ------------------------------------------------
run_retrieval() {
  need aws "It calls the procedure-search function."
  aws_whoami
  assert_aws_environment "$ENV"
  local fn="$PROJECT-procedure-search" cases="test/agents/sop-retrieval-cases.json"
  step "SOP retrieval: ask $fn every golden question"
  mkdir -p "$work/answers"
  # shellcheck disable=SC2016  # the template literal is JavaScript
  node -e '
    const spec = require(process.argv[1]);
    for (const c of spec.cases) {
      const event = { body: JSON.stringify({ query: c.query, maxResults: spec.maxResults || 3 }) };
      require("fs").writeFileSync(`${process.argv[2]}/${c.id}.payload.json`, JSON.stringify(event));
    }' "$REPO_ROOT/$cases" "$work/answers"
  local payload id
  for payload in "$work"/answers/*.payload.json; do
    id=$(basename "$payload" .payload.json)
    aws lambda invoke --function-name "$fn" --cli-binary-format raw-in-base64-out \
      --payload "fileb://$payload" "$work/answers/$id.json" > /dev/null \
      || die "Could not invoke $fn. Deploy AWS for $ENV first (scripts/deploy-aws.sh $ENV)."
  done
  endstep
  step "SOP retrieval: score"
  if node scripts/lib/sop-retrieval-eval.js "$cases" "$work/answers" \
       --junit "$OUT/sop-retrieval.xml" --summary "$OUT/summary.md"; then
    note "SOP retrieval eval passed."
  else
    warn "SOP retrieval eval is below its thresholds (table above)."
    failed="$failed retrieval"
  fi
  endstep
}

# --- Agentforce: Testing Center --------------------------------------------
soql() { sf data query --target-org "$org" --query "$1" --json 2>/dev/null; }
first_field() {  # first_field <json> <field>: the field of the first record, or empty
  # shellcheck disable=SC2016  # the template literal is JavaScript
  node -e '
    let raw = ""; process.stdin.on("data", (d) => raw += d).on("end", () => {
      try { const r = JSON.parse(raw).result.records[0]; process.stdout.write(r ? String(r[process.argv[1]] ?? "") : ""); }
      catch { process.stdout.write(""); }
    });' "$2" <<< "$1"
}

# The org's API name for a subagent. Publishing an Agent Script agent may
# give its subagents generated names with a suffix; Testing Center compares
# against those. Falls back to the name as written.
topic_api_name() {  # topic_api_name <agent> <subagent>
  local found
  found=$(first_field "$(soql "SELECT DeveloperName FROM GenAiPluginDefinition WHERE DeveloperName LIKE '$2%' ORDER BY LastModifiedDate DESC LIMIT 1")" DeveloperName)
  printf '%s' "${found:-$2}"
}

verified_session_id() {
  local filter="MessagingEndUser.MessagingPlatformKey LIKE 'v2/iamessage/AUTH/%'" user
  if [ -n "${EVAL_PATIENT_USERNAME:-}" ]; then
    user=$(first_field "$(soql "SELECT Id FROM User WHERE Username = '$EVAL_PATIENT_USERNAME' LIMIT 1")" Id)
    [ -n "$user" ] || die "No user $EVAL_PATIENT_USERNAME in $org."
    filter="$filter AND MessagingEndUser.MessagingPlatformKey LIKE '%uid:$user'"
  fi
  first_field "$(soql "SELECT Id FROM MessagingSession WHERE $filter ORDER BY CreatedDate DESC LIMIT 1")" Id
}

run_agent_test() {  # run_agent_test <spec> <values...>
  local spec="$1"; shift
  local agent test rendered args=() topic junit
  agent=$(sed -n 's/^subjectName:[[:space:]]*//p' "$spec")
  test="${agent}_Eval"
  rendered="$work/$(basename "$spec")"
  for topic in $(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");console.log(require(process.argv[2]).topicsOf(s).join(" "))' "$spec" "$REPO_ROOT/scripts/lib/agent-spec.js"); do
    args+=(--topic "$topic=$(topic_api_name "$agent" "$topic")")
  done
  node scripts/lib/agent-spec.js "$spec" "$rendered" "$@" ${args[@]+"${args[@]}"}

  step "Testing Center: create $test from $spec"
  sf agent test create --spec "$rendered" --api-name "$test" --force-overwrite --target-org "$org" \
    || die "Could not create $test. Is $agent published and active in $org (scripts/publish-agent.sh $ENV $agent)?"
  endstep

  step "Testing Center: run $test"
  mkdir -p "$OUT/$test"
  sf agent test run --api-name "$test" --wait 20 --result-format junit --output-dir "$OUT/$test" --target-org "$org" \
    || true   # pass or fail is read from the JUnit file below
  junit=$(find "$OUT/$test" -name '*.xml' | head -1)
  if [ -z "$junit" ]; then
    warn "$test wrote no results within 20 minutes. Get them later with: sf agent test results --use-most-recent --target-org $org"
    failed="$failed $test"
  else
    # Testing Center writes a <failure> for every check below its bar,
    # including the LLM-judged quality scores (coherence, completeness,
    # conciseness, latency). Those are reported; only the checks of what the
    # agent did (routing, actions, the judged answer, custom evaluations)
    # decide pass or fail.
    local hard soft
    hard=$(grep -oE '<failure [^>]*name="(topic_assertion|actions_assertion|output_validation|string_comparison|numeric_comparison)"' "$junit" | sed -E 's/.*name="([a-z_]+)"/\1/' | sort | uniq -c | tr -s ' ' | tr '\n' ',' || true)
    soft=$(grep -oE '<failure [^>]*name="(coherence|completeness|conciseness|output_latency_milliseconds)"' "$junit" | sed -E 's/.*name="([a-z_]+)"/\1/' | sort | uniq -c | tr -s ' ' | tr '\n' ',' || true)
    if [ -n "$hard" ]; then
      warn "$test has failing checks:${hard%,} ($junit)."
      failed="$failed $test"
    else
      note "$test passed."
    fi
    [ -z "$soft" ] || note "$test quality scores below their bar (reported, not failing):${soft%,}"
    { echo "### $test"; echo; echo "Failing checks: ${hard:-none}"; echo; echo "Quality scores below bar: ${soft:-none}"; echo; echo "Results: \`$junit\`"; echo; } >> "$OUT/summary.md"
  fi
  endstep
}

close_eval_cases() {  # close_eval_cases <ISO start time>
  step "Close the Cases the eval opened"
  cat > "$work/close.apex" <<APEX
Datetime since = (Datetime) JSON.deserialize('"$1"', Datetime.class);
List<Case> opened = [
    SELECT Id FROM Case
    WHERE CreatedDate >= :since AND IsClosed = false
      AND (Subject = 'Device escalation: $DEVICE' OR Subject = 'Patient request: nurse')
];
for (Case c : opened) { c.Status = 'Closed'; }
update opened;
System.debug('Closed ' + opened.size() + ' eval Cases');
APEX
  sf apex run --file "$work/close.apex" --target-org "$org" > /dev/null \
    || warn "Could not close the eval's Cases. Close Cases opened since $1 on $DEVICE by hand."
  endstep
}

run_agents() {
  need sf "It runs the Testing Center tests."
  local started session
  started=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  run_agent_test test/agents/Patient_Care_Agent-testSpec.yaml "DEVICE=$DEVICE"

  session=$(verified_session_id)
  if [ -z "$session" ]; then
    warn "No verified portal chat in $org, so the patient agent tests were skipped. Sign in to the portal as the test patient, open the chat once, and run again."
    failed="$failed Patient_Portal_Agent_Eval(skipped)"
  else
    run_agent_test test/agents/Patient_Portal_Agent-testSpec.yaml \
      "VERIFIED_SESSION_ID=$session" "OTHER_DEVICE=$OTHER_DEVICE"
  fi
  close_eval_cases "$started"
}

case "$PART" in
  retrieval) run_retrieval ;;
  agents)    run_agents ;;
  all)       run_retrieval; run_agents ;;
esac

[ "$SUMMARY" = "$OUT/summary.md" ] || cat "$OUT/summary.md" >> "$SUMMARY"
[ -z "$failed" ] || die "Evals not passing:$failed. Results in $OUT."
note "All evals passed. Results in $OUT."
