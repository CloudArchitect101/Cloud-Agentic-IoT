#!/bin/bash
# Interactively sets up a GitHub Environment (Dev or Prod) with the GitHub CLI:
# its branch rule (and, for Prod, you as required reviewer), every secret and
# variable .github/workflows/deploy.yml reads, and AUTO_DEPLOY. Secrets are
# typed hidden or read from key files, never pasted into a browser or a chat.
#
# Run it from the repository root, after scripts/bootstrap-aws.sh, with
# AWS_PROFILE set to that environment's account so it can read the deploy
# role's ARN from the bootstrap stack.

set -euo pipefail

# --- Helper Functions ---
function check_dep() {
    if ! command -v "$1" &> /dev/null; then
        echo "Error: command '$1' could not be found."
        echo "Please install it and ensure it's in your PATH."
        exit 1
    fi
}

function ask() {
    local prompt default
    prompt="$1"
    default="${2:-}"
    if [[ -n "$default" ]]; then
        read -rp "  $prompt [$default]: " REPLY
        REPLY=${REPLY:-$default}
    else
        read -rp "  $prompt: " REPLY
    fi
}

function ask_secret() {
    local prompt
    prompt="$1"
    read -rsp "  $prompt: " REPLY
    echo
}

# --- Main Script ---
echo "GitHub Actions Secrets & Variables Setup"
echo "----------------------------------------"
echo "This script will guide you through setting repository secrets and variables"
echo "for a specific environment (e.g., Dev, Prod) using the GitHub CLI."
echo

# 1. Check dependencies
check_dep "gh"
check_dep "base64"

# 2. Check auth status
if ! gh auth status &> /dev/null; then
    echo "Error: Not logged into GitHub."
    echo "Please run 'gh auth login' and authenticate."
    exit 1
fi
echo "✓ Logged into GitHub as '$(gh auth status 2>&1 | grep "Logged in to" | sed "s/.* as //")'"

# 3. Get environment and ensure it exists
echo
echo "Which environment are you setting up?"
options=("Dev" "Prod" "Quit")
select opt in "${options[@]}"; do
    case $opt in
        "Dev"|"Prod")
            ENV=$opt
            break
            ;;
        "Quit")
            echo "Aborted by user."
            exit 0
            ;;
        *) echo "Invalid option $REPLY. Please choose 1, 2, or 3.";;
    esac
done

echo
echo "Checking for GitHub Environment '$ENV'..."
# The {owner}/{repo} placeholders are automatically resolved by `gh api`.
if ! gh api "repos/{owner}/{repo}/environments/$ENV" --silent &> /dev/null; then
    echo "Environment '$ENV' not found. Creating it..."
else
    echo "✓ Environment '$ENV' already exists. Updating its rules..."
fi
# Only the branch of the same name may deploy to the environment: the AWS role
# trusts the environment, not the branch (infra/bootstrap/github-deploy.yaml),
# so this is what keeps another branch from assuming it. Prod also waits for
# your approval on every run.
env_args=(-X PUT --silent
    -F "deployment_branch_policy[protected_branches]=false"
    -F "deployment_branch_policy[custom_branch_policies]=true")
if [[ "$ENV" == "Prod" ]]; then
    env_args+=(-F "reviewers[][type]=User" -F "reviewers[][id]=$(gh api user --jq .id)")
fi
if gh api "repos/{owner}/{repo}/environments/$ENV" "${env_args[@]}"; then
    echo "✓ '$ENV' deploys only from the branches its policy names."
    if [[ "$ENV" == "Prod" ]]; then echo "✓ You are Prod's required reviewer."; fi
else
    echo "Warning: could not set the environment's rules. A required reviewer on a private repository needs a paid GitHub plan; set them in Settings -> Environments -> $ENV."
fi
if ! gh api "repos/{owner}/{repo}/environments/$ENV/deployment-branch-policies" --jq '.branch_policies[].name' 2> /dev/null | grep -qx "$ENV"; then
    gh api "repos/{owner}/{repo}/environments/$ENV/deployment-branch-policies" -X POST -f "name=$ENV" -f type=branch --silent \
        && echo "✓ Only the '$ENV' branch may deploy to '$ENV'." \
        || echo "Warning: could not add the '$ENV' branch policy. Add it in Settings -> Environments -> $ENV -> Deployment branches."
fi
echo
echo "Setting up for environment: $ENV"
echo "You will be prompted for each value. For secrets, your input will be hidden."
echo "---"

# 4. Set secrets
echo "Setting secrets..."

# set_secret <name> <value>: from stdin, so the value is never an argument.
function set_secret() {
    if [[ -n "$2" ]]; then
        printf '%s' "$2" | gh secret set "$1" --env "$ENV"
        echo "✓ Secret '$1' set."
    else
        echo "Skipped $1."
    fi
}

# set_key_secret <name> <prompt> <default file>: a private key, base64-encoded
# as the workflow expects, straight from the file to gh.
function set_key_secret() {
    ask "$2" "$3"
    if [[ -f "$REPLY" ]]; then
        base64 < "$REPLY" | gh secret set "$1" --env "$ENV"
        echo "✓ Secret '$1' set from '$REPLY' (base64 encoded)."
    else
        echo "Warning: File '$REPLY' not found. Skipped $1."
    fi
}

echo "The deploy user (the pipeline signs in to Salesforce as it):"
ask_secret "Enter SF_CONSUMER_KEY (from the Cloud Agentic IoT Deploy app)"
set_secret SF_CONSUMER_KEY "$REPLY"
ask "Enter SF_USERNAME (e.g., deploy@iot-dev.example.com)" ""
set_secret SF_USERNAME "$REPLY"
set_key_secret SF_JWT_KEY "Enter path to the deploy user's JWT private key file" "scripts/server-deploy.key"

echo
echo "The integration user (scripts/seed-ssm.sh copies these into SSM for the Lambdas)."
echo "  No Integration app yet? Skip them: the first run writes placeholders, and"
echo "  you run this again once the app exists (docs/SETUP.md, section 6.3)."
ask_secret "Enter SF_INTEGRATION_CONSUMER_KEY (from the Cloud Agentic IoT Integration app)"
set_secret SF_INTEGRATION_CONSUMER_KEY "$REPLY"
ask "Enter SF_INTEGRATION_USERNAME (e.g., integration@iot-dev.example.com)" ""
set_secret SF_INTEGRATION_USERNAME "$REPLY"
set_key_secret SF_INTEGRATION_JWT_KEY "Enter path to the integration user's JWT private key file" "scripts/server-integration.key"

ask_secret "Enter SLACK_SIGNING_SECRET (optional; Enter skips, and the Slack stack is skipped)"
set_secret SLACK_SIGNING_SECRET "$REPLY"

# The bootstrap stack (scripts/bootstrap-aws.sh) made the role; read its ARN
# rather than copy it, when this shell can see that account.
role_default=""
if command -v aws &> /dev/null; then
    role_default=$(aws cloudformation describe-stacks --stack-name "cloud-agentic-iot-bootstrap-$ENV" \
        --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text 2> /dev/null || true)
    if [[ "$role_default" == "None" ]]; then role_default=""; fi
fi
ask "Enter AWS_ROLE_ARN (the bootstrap stack's DeployRoleArn)" "$role_default"
set_secret AWS_ROLE_ARN "$REPLY"

echo "---"

# 5. Set variables
echo "Now setting variables (values will be visible)."

# The Live Status card connects to AWS IoT over a WebSocket, and Salesforce
# allows only the Regions force-app lists as CSP trusted sites.
ask "Enter AWS_REGION:" "ca-central-1"
if [[ -n "$REPLY" ]]; then
    csp="force-app/main/default/cspTrustedSites/AWS_IoT_WebSocket_${REPLY//-/_}.cspTrustedSite-meta.xml"
    if [[ ! -f "$(dirname "$0")/../$csp" ]]; then
        echo "Warning: $csp does not exist, so the Live Status card would be blocked in $REPLY. Add it before deploying."
    fi
    gh variable set AWS_REGION --body "$REPLY" --env "$ENV"
    echo "✓ Variable 'AWS_REGION' set."
else
    echo "Skipped AWS_REGION."
fi

ask "Enter ALARM_EMAIL (who the CloudWatch alarms email; Enter skips)" ""
if [[ -n "$REPLY" ]]; then
    gh variable set ALARM_EMAIL --body "$REPLY" --env "$ENV"
    echo "✓ Variable 'ALARM_EMAIL' set. Confirm the subscription in the email AWS sends after the first deploy."
else
    echo "Skipped ALARM_EMAIL."
fi

# The deploy workflow passes this straight to `sf org login jwt --instance-url`.
# Leaving it unset used to interpolate to an empty string and fail the login,
# so the workflow now defaults it too — but set it explicitly when the target
# is a sandbox, because that default is wrong there.
echo "  (login.salesforce.com for a Developer Edition or production org;"
echo "   test.salesforce.com for a sandbox)"
ask "Enter SF_LOGIN_URL:" "https://login.salesforce.com"
if [[ -n "$REPLY" ]]; then
    gh variable set SF_LOGIN_URL --body "$REPLY" --env "$ENV"
    echo "✓ Variable 'SF_LOGIN_URL' set."
else
    echo "Skipped SF_LOGIN_URL."
fi

# AUTO_DEPLOY is a repository variable: it decides whether a push to a branch
# deploys at all (.github/workflows/deploy.yml).
current=$(gh variable get AUTO_DEPLOY 2> /dev/null || true)
echo
echo "AUTO_DEPLOY is '${current:-not set}'. Pushes to a branch deploy only when it names the branch."
read -rp "  Let pushes to '$ENV' deploy (adds it to AUTO_DEPLOY)? [y/N] " answer
if [[ "$answer" == "y" || "$answer" == "Y" ]]; then
    case " $current " in
        *" $ENV "*) echo "✓ AUTO_DEPLOY already names $ENV." ;;
        *) gh variable set AUTO_DEPLOY --body "${current:+$current }$ENV"
           echo "✓ AUTO_DEPLOY is now '${current:+$current }$ENV'." ;;
    esac
fi

echo
echo "---"
echo "✅ Setup complete for environment '$ENV'."
echo "Next: Actions -> Deploy -> Run workflow on '$ENV' (docs/SETUP.md, section 6.3)."