#!/usr/bin/env bash
#
# bootstrap-aws.sh - once per AWS account: the role GitHub Actions deploys as,
# and the monthly budget. Run it as iot-operator, before the first pipeline run.
#
#   AWS_PROFILE=iot-dev BUDGET_USD=20 BUDGET_EMAIL=you@example.com scripts/bootstrap-aws.sh Dev
#
# It deploys infra/bootstrap/github-deploy.yaml as cloud-agentic-iot-bootstrap-<env>:
# the GitHub OIDC provider, the github-actions-deploy role that trusts this
# repository's <env> GitHub Environment, its cloud-agentic-iot-deploy policy,
# and the cloud-agentic-iot-monthly budget the Home page shows. Then it offers
# to store the role's ARN as the environment's AWS_ROLE_ARN secret.
#
# Settings, from the environment (never from a file in the repository):
#   BUDGET_USD      the monthly budget in USD; 0 or unset keeps what the stack has
#                   (none on a first run)
#   BUDGET_EMAIL    who the budget emails at 80% actual and 100% forecast
#   GITHUB_REPO     owner/name; read from `gh` when unset
#   GITHUB_OIDC=no  an AWS project with a spend limit, which cannot hold an
#                   OIDC provider: only the budget is created (docs/TRY-IT.md)
#   EXISTING_OIDC_PROVIDER_ARN  an account's GitHub provider that this stack
#                   did not create, to use instead of creating one
#
# Running it again is safe: it updates the stack, and what you leave unset
# keeps the value the stack already has. Prod is bootstrapped from a laptop
# too: the pipeline cannot create the role it signs in with.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ENV="${1:-}"
check_environment "$ENV"
cd "$REPO_ROOT"

TEMPLATE=infra/bootstrap/github-deploy.yaml
STACK="$PROJECT-bootstrap-$ENV"
PROVIDER_URL=token.actions.githubusercontent.com

aws_whoami
# The label is checked, and on a fresh account written, before anything else
# changes: a Dev bootstrap cannot land in the Prod account by a wrong profile.
assert_aws_environment "$ENV"

stack_exists=false
aws cloudformation describe-stacks --stack-name "$STACK" > /dev/null 2>&1 && stack_exists=true

overrides=("Environment=$ENV")

if [ "${GITHUB_OIDC:-yes}" = "no" ]; then
  overrides+=("CreateGitHubDeploy=false")
  note "GITHUB_OIDC=no: no OIDC provider and no deploy role, only the budget."
else
  overrides+=("CreateGitHubDeploy=true")
  repo="${GITHUB_REPO:-}"
  owner_id="" repo_id=""
  if command -v gh > /dev/null 2>&1; then
    # GitHub's own spelling: the OIDC subject is compared case by case.
    # {owner}/{repo} is gh's own placeholder for the checkout's repository.
    path="repos/{owner}/{repo}"
    [ -z "$repo" ] || path="repos/$repo"
    if ids=$(gh api "$path" --jq '"\(.full_name) \(.owner.id) \(.id)"' 2> /dev/null); then
      read -r repo owner_id repo_id <<< "$ids"
    else
      warn "gh could not read the repository, so only the plain subject form is trusted."
    fi
  fi
  [ -n "$repo" ] || die "Set GITHUB_REPO=owner/name, or sign gh in (gh auth login) so it can be read."
  case "$repo" in */*) ;; *) die "GITHUB_REPO must be owner/name, not '$repo'." ;; esac
  overrides+=("GitHubOwner=${repo%%/*}" "GitHubRepoName=${repo#*/}" "GitHubOwnerId=$owner_id" "GitHubRepoId=$repo_id")
  echo "GitHub repository $repo, environment $ENV"

  # An account holds one provider per URL. One this stack did not create must
  # be named, or CloudFormation fails halfway with "already exists".
  if [ -n "${EXISTING_OIDC_PROVIDER_ARN:-}" ]; then
    overrides+=("ExistingProviderArn=$EXISTING_OIDC_PROVIDER_ARN")
  elif [ "$stack_exists" = false ]; then
    existing=$(aws iam list-open-id-connect-providers \
      --query "OpenIDConnectProviderList[?ends_with(Arn, '/$PROVIDER_URL')].Arn" --output text)
    if [ -n "$existing" ] && [ "$existing" != "None" ]; then
      die "This account already has the $PROVIDER_URL provider. Rerun with EXISTING_OIDC_PROVIDER_ARN=$existing"
    fi
  fi
fi

if [ -n "${BUDGET_USD:-}" ] && [ "${BUDGET_USD}" != "0" ]; then
  case "$BUDGET_USD" in *[!0-9.]*|'') die "BUDGET_USD must be a number of US dollars, not '$BUDGET_USD'." ;; esac
  overrides+=("MonthlyBudgetUsd=$BUDGET_USD")
elif [ "$stack_exists" = false ]; then
  warn "BUDGET_USD is not set, so no budget is created. The Home page shows no spend until the budget cloud-agentic-iot-monthly exists."
fi
[ -z "${BUDGET_EMAIL:-}" ] || overrides+=("BudgetEmail=$BUDGET_EMAIL")

step "Deploy $TEMPLATE as $STACK"
aws cloudformation deploy \
  --template-file "$TEMPLATE" \
  --stack-name "$STACK" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${overrides[@]}"
endstep

[ "${GITHUB_OIDC:-yes}" = "no" ] && { note "AWS $ENV is bootstrapped (budget only)."; exit 0; }

role=$(stack_output "$STACK" DeployRoleArn)
[ -n "$role" ] && [ "$role" != "None" ] || die "$STACK has no DeployRoleArn output."
echo "Deploy role: $role"

if [ -t 0 ] && command -v gh > /dev/null 2>&1; then
  read -rp "Store it as the $ENV environment's AWS_ROLE_ARN secret in GitHub? [y/N] " answer
  if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
    printf '%s' "$role" | gh secret set AWS_ROLE_ARN --env "$ENV"
    echo "  AWS_ROLE_ARN set."
  fi
else
  echo "Store it as the $ENV environment's AWS_ROLE_ARN secret: printf '%s' '<the ARN>' | gh secret set AWS_ROLE_ARN --env $ENV"
fi
note "AWS $ENV is bootstrapped. Next: scripts/setup-github-secrets.sh, then the first Deploy run (docs/SETUP.md, section 6)."
