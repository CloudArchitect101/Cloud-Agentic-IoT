#!/usr/bin/env bash
#
# seed-ssm.sh - put the Salesforce integration settings, and the optional Slack
# signing secret, into one environment's SSM Parameter Store, where the stacks
# and the Lambdas read them.
#
#   scripts/seed-ssm.sh Dev                       # on a laptop: asks for what is missing
#   SF_INTEGRATION_JWT_KEY_FILE=scripts/server-integration.key scripts/seed-ssm.sh Dev
#
# The pipeline runs this same script, with the GitHub Environment's secrets in
# the variables below, right before scripts/deploy-aws.sh. On a laptop it asks
# for each one you have not exported, and never shows what you type.
#
#   SF_INTEGRATION_CONSUMER_KEY   the Integration External Client App's consumer key
#   SF_INTEGRATION_USERNAME       integration@...
#   SF_INTEGRATION_JWT_KEY        the integration private key, base64-encoded (the GitHub secret)
#   SF_INTEGRATION_JWT_KEY_FILE   or the key file itself (a laptop)
#   SF_LOGIN_URL                  default https://login.salesforce.com
#   SLACK_SIGNING_SECRET          optional; without it the Slack stack is skipped
#
# A brand-new environment has none of the integration values yet: the
# integration user and its app need the Device_Integration permission set,
# which the first Salesforce deploy creates. So a value that is not given and
# not in SSM yet is written as "placeholder". The stacks then deploy, the
# Salesforce deploy follows, and only the calls to Salesforce fail until the
# real values are seeded and AWS is deployed again. A value already in SSM is
# never replaced by a placeholder.
#
# The values never pass through a command line: each is written to a private
# temporary file and handed to the AWS CLI as file://.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ENV="${1:-}"
check_environment "$ENV"
refuse_local_prod "$ENV" "Prod's secrets come from the Prod GitHub Environment: the pipeline seeds them."
cd "$REPO_ROOT"

PLACEHOLDER=placeholder
SF=/$PROJECT/salesforce

# Which account first, then the label, before anything is written: a Dev
# role pointing into the Prod account must not put Dev's key there.
aws_whoami
assert_aws_environment "$ENV"

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
chmod 700 "$scratch"

exists() { aws ssm get-parameter --name "$1" --query Parameter.Name --output text > /dev/null 2>&1; }

# Interactive only on a laptop with a terminal. Each prompt can be skipped.
interactive=false
if ! in_ci && [ -t 0 ]; then interactive=true; fi

ask() {   # ask <variable> <prompt> [secret]
  local name="$1" prompt="$2" answer=""
  [ -z "${!name:-}" ] || return 0
  [ "$interactive" = true ] || return 0
  if [ "${3:-}" = secret ]; then
    read -rsp "  $prompt (hidden; Enter skips): " answer; echo
  else
    read -rp "  $prompt (Enter skips): " answer
  fi
  printf -v "$name" '%s' "$answer"
}

# put <String|SecureString> <name> <file holding the value, or empty> <placeholder|skip>
PLACEHOLDERS=""
put() {
  local type="$1" name="$2" file="$3" missing="$4" have
  if [ -z "$file" ]; then
    if exists "$name"; then
      echo "  kept $name"
      return 0
    fi
    if [ "$missing" = skip ]; then
      echo "  skipped $name: not set"
      return 0
    fi
    file="$scratch/placeholder"
    printf '%s' "$PLACEHOLDER" > "$file"
    PLACEHOLDERS="$PLACEHOLDERS $name"
  fi
  # SSM cannot change a parameter's type in place, and some of these used to
  # be Strings: replace the old one once.
  have=$(aws ssm describe-parameters --parameter-filters "Key=Name,Values=$name" \
           --query 'Parameters[0].Type' --output text)
  if [ -n "$have" ] && [ "$have" != "None" ] && [ "$have" != "$type" ]; then
    aws ssm delete-parameter --name "$name"
    echo "  $name was a $have; replaced with a $type"
  fi
  aws ssm put-parameter --name "$name" --type "$type" --overwrite --value "file://$file" > /dev/null
  if [ "$file" = "$scratch/placeholder" ]; then
    echo "  $name: placeholder"
  else
    echo "  seeded $name ($type)"
  fi
}

# value_file <variable>: the variable's value in a private file, or nothing.
value_file() {
  local name="$1" file
  [ -n "${!name:-}" ] || return 0
  file="$scratch/$name"
  printf '%s' "${!name}" > "$file"
  echo "$file"
}

step "Seed SSM for $ENV in AWS account $AWS_ACCOUNT_ID"

if [ "$interactive" = true ]; then
  echo "Values you do not give are kept when SSM has them, or written as \"$PLACEHOLDER\" when it does not."
fi
ask SF_INTEGRATION_USERNAME "Integration username (integration@...)"
ask SF_INTEGRATION_CONSUMER_KEY "Integration app consumer key" secret

# The private key, as a file the CLI reads, never as text in a variable that
# might be printed.
key_file=""
if [ -n "${SF_INTEGRATION_JWT_KEY:-}" ]; then
  key_file="$scratch/jwt.key"
  printf '%s' "$SF_INTEGRATION_JWT_KEY" | base64 --decode > "$key_file" 2> /dev/null \
    || die "SF_INTEGRATION_JWT_KEY is not base64. Store it as: base64 < server-integration.key"
elif [ -n "${SF_INTEGRATION_JWT_KEY_FILE:-}" ]; then
  key_file="$SF_INTEGRATION_JWT_KEY_FILE"
  [ -f "$key_file" ] || die "SF_INTEGRATION_JWT_KEY_FILE names no file: $key_file"
elif [ "$interactive" = true ]; then
  default="" hint="Enter skips"
  if [ -f scripts/server-integration.key ]; then
    default=scripts/server-integration.key hint="Enter takes $default"
  fi
  read -rp "  Integration private key file ($hint): " answer
  key_file="${answer:-$default}"
  [ -z "$key_file" ] || [ -f "$key_file" ] || die "No file $key_file"
fi
if [ -n "$key_file" ]; then
  grep -q "PRIVATE KEY" "$key_file" \
    || die "The integration key is not a PEM private key. It is the server-integration.key made in docs/SETUP.md, section 2.4."
fi

ask SLACK_SIGNING_SECRET "Slack signing secret, if you use Slack" secret

if [ -z "${SF_INTEGRATION_CONSUMER_KEY:-}" ] && ! exists "$SF/consumer-key"; then
  warn "No integration consumer key yet. The Lambdas cannot sign in to Salesforce until the Integration External Client App exists and this is run again with its consumer key."
fi

put String "$SF/consumer-key" "$(value_file SF_INTEGRATION_CONSUMER_KEY)" placeholder
put String "$SF/username"     "$(value_file SF_INTEGRATION_USERNAME)" placeholder
# The login URL has a default, so a fresh environment needs no placeholder.
if [ -z "${SF_LOGIN_URL:-}" ] && ! exists "$SF/login-url"; then SF_LOGIN_URL=https://login.salesforce.com; fi
put String "$SF/login-url"    "$(value_file SF_LOGIN_URL)" skip
put SecureString "$SF/jwt-private-key" "$key_file" placeholder
put SecureString "/$PROJECT/slack/signing-secret" "$(value_file SLACK_SIGNING_SECRET)" skip
endstep

if [ -n "$PLACEHOLDERS" ]; then
  note "Written as placeholders:$PLACEHOLDERS. Everything deploys; calls to Salesforce fail until you run scripts/seed-ssm.sh $ENV with the real values and deploy AWS again."
fi
# CloudFormation copies the username, consumer key and login URL into the
# functions only when it deploys; the key and the Slack secret are read at
# runtime.
in_ci || note "SSM for $ENV is seeded. Next: scripts/deploy-aws.sh $ENV, so the functions pick up the new values."
