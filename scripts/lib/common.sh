# shellcheck shell=bash
#
# common.sh - helpers the check, deploy, firmware and OTA scripts share.
# Sourced by them, never run on its own.
#
# The same scripts run on your laptop and in GitHub Actions. What differs is
# cosmetic - in Actions, messages become ::group:: and ::error:: lines so the
# log folds and failures are annotated - plus one rule: Prod is changed by the
# pipeline, not from a laptop. Which stacks, which tests, which binary: all
# identical, so a green run on your machine predicts a green pipeline.
#
# Written for bash 3.2, the version macOS ships: no ${var,,}, no mapfile, no
# associative arrays.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT=cloud-agentic-iot

in_ci() { [ "${GITHUB_ACTIONS:-}" = "true" ]; }

step()    { if in_ci; then echo "::group::$*"; else printf '\n\033[1m== %s\033[0m\n' "$*"; fi; }
endstep() { if in_ci; then echo "::endgroup::"; fi; }
note()    { if in_ci; then echo "::notice::$*"; else printf 'note: %s\n' "$*"; fi; }
warn()    { if in_ci; then echo "::warning::$*"; else printf '\033[33mwarning: %s\033[0m\n' "$*" >&2; fi; }
die()     { if in_ci; then echo "::error::$*"; else printf '\033[31merror: %s\033[0m\n' "$*" >&2; fi; exit 1; }

need() { command -v "$1" > /dev/null 2>&1 || die "$1 is not installed. $2"; }

# The environment name is also the branch name, the GitHub Environment name and
# the suffix on every stack name, so one spelling is checked in one place.
check_environment() {
  case "${1:-}" in
    Dev|Prod) ;;
    *) die "Name the environment, Dev or Prod (got '${1:-nothing}')." ;;
  esac
}

# Prod changes through the pipeline only: a merge into the Prod branch, checks
# green on that exact commit, and your approval on the Prod environment. A
# deploy from a laptop would skip all three, so the scripts refuse it unless
# you say, in so many words, that this is the break-glass case.
refuse_local_prod() {
  if [ "$1" = "Prod" ] && ! in_ci && [ "${ALLOW_LOCAL_PROD:-}" != "yes" ]; then
    die "${2:-Prod is deployed by the pipeline: merge Dev into Prod and approve the run.} In a genuine emergency, rerun with ALLOW_LOCAL_PROD=yes."
  fi
}

# detect_port - prints the first serial port with the usual name an ESP32's
# USB-serial chip gets on macOS or Linux, or fails if none is plugged in. A
# loop rather than `ls ... | head`: with pipefail, ls failing on the names
# that match nothing would stop the calling script without a word.
detect_port() {
  local p
  for p in /dev/cu.usbserial-* /dev/cu.SLAB_USBtoUART /dev/cu.wchusbserial* /dev/ttyUSB* /dev/ttyACM*; do
    if [ -e "$p" ]; then printf '%s' "$p"; return 0; fi
  done
  return 1
}

stack_name() { printf '%s-%s-%s' "$PROJECT" "$1" "$2"; }   # stack_name <dir> <env>

# Where scripts/deploy-aws.sh publishes config/vital-thresholds.json. The
# templates' ThresholdsParameterName defaults to the same name.
# shellcheck disable=SC2034  # used by the scripts that source this file
THRESHOLDS_PARAM=/cloud-agentic-iot/config/vital-thresholds

# package_function <lambda/dir> - zips one function with exactly its declared
# dependencies and prints the zip's path.
#
# Built in a scratch copy, so whatever node_modules your checkout has never
# ends up in the zip. The copy keeps the function's place in the tree next to
# lambda/shared, because functions depend on it as "file:../shared";
# --install-links copies it into node_modules as a real package, with its own
# dependencies, instead of a symlink the zip would not follow out of the copy.
package_function() {
  local dir="$1" build
  build=$(mktemp -d)
  mkdir -p "$build/$(dirname "$dir")"
  cp -R "$dir" "$build/$dir"
  cp -R "$REPO_ROOT/lambda/shared" "$build/lambda/shared"
  rm -rf "$build/$dir/node_modules" "$build/lambda/shared/node_modules"
  if [ -f "$build/$dir/package.json" ]; then
    (cd "$build/$dir" && npm install --omit=dev --install-links --no-audit --no-fund --loglevel=error) >&2
  fi
  (cd "$build/$dir" && zip -qr "$build.zip" .)
  rm -rf "$build"
  echo "$build.zip"
}

# ------------------------------------------------------------------- AWS

# Says which account and identity the AWS CLI is about to act as, before
# anything changes, so a wrong AWS_PROFILE shows up on the first line.
aws_whoami() {
  need aws "Install AWS CLI v2 - see docs/SETUP.md."
  local who
  who=$(aws sts get-caller-identity --query '[Account,Arn]' --output text) \
    || die "The AWS CLI has no working credentials. On a laptop: export AWS_PROFILE=iot-dev"
  AWS_ACCOUNT_ID=${who%%[[:space:]]*}
  AWS_REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region || true)}}
  [ -n "$AWS_REGION" ] || die "No AWS region set. Set one on the profile, or export AWS_REGION."
  export AWS_REGION AWS_ACCOUNT_ID
  echo "AWS account $AWS_ACCOUNT_ID in $AWS_REGION, as ${who#*[[:space:]]}"
}

# Each environment has its own AWS account: function and group names are
# fixed, so two environments cannot share one. The account records which
# environment it is in SSM, and every deploy checks that label - Dev code cannot
# land in the Prod account because the wrong profile was active. The first
# deploy into a fresh account writes the label.
ENV_PARAM=/cloud-agentic-iot/environment
assert_aws_environment() {
  local want="$1" have hint="Check AWS_PROFILE before going any further."
  in_ci && hint="The $want environment's AWS_ROLE_ARN points into the wrong account."
  if have=$(aws ssm get-parameter --name "$ENV_PARAM" --query Parameter.Value --output text 2>&1); then
    [ "$have" = "$want" ] || die "AWS account $AWS_ACCOUNT_ID is labelled $have, not $want. $hint"
  elif [[ "$have" == *ParameterNotFound* ]]; then
    aws ssm put-parameter --name "$ENV_PARAM" --type String --value "$want" \
      --description "Which environment this account hosts. Every deploy checks it." > /dev/null
    note "First deploy into AWS account $AWS_ACCOUNT_ID: labelled it $want ($ENV_PARAM)."
  else
    die "Could not read $ENV_PARAM: $have"
  fi
}

stack_output() {   # stack_output <stack> <output key>
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null || true
}

# -------------------------------------------------------------- firmware

# A sketch is a folder under firmware/ holding a .ino named after the folder.
sketches() {
  local dir name
  for dir in "$REPO_ROOT"/firmware/*/; do
    name=$(basename "$dir")
    if [ -f "$dir$name.ino" ]; then echo "$name"; fi
  done
}

# Reads a sketch's source on stdin and prints its FIRMWARE_VERSION, or nothing.
version_of() {
  grep -oE '#define[[:space:]]+FIRMWARE_VERSION[[:space:]]+"[^"]+"' \
    | grep -oE '"[^"]+"' | tr -d '"' || true
}
