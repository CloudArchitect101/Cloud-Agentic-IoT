#!/bin/bash
# Interactively sets up GitHub secrets and variables for an environment using the GitHub CLI.
# This avoids copy-pasting secrets into the GitHub web UI.

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
        read -p "  $prompt [$default]: " REPLY
        REPLY=${REPLY:-$default}
    else
        read -p "  $prompt: " REPLY
    fi
}

function ask_secret() {
    local prompt
    prompt="$1"
    read -sp "  $prompt: " REPLY
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
    gh api "repos/{owner}/{repo}/environments/$ENV" -X PUT --silent
    echo "✓ Environment '$ENV' created."
    if [[ "$ENV" == "Prod" ]]; then
        echo "🔔 IMPORTANT: The 'Prod' environment has been created. You should now configure a 'required reviewer' protection rule for it in your repository settings (Settings -> Environments -> Prod)."
    fi
else
    echo "✓ Environment '$ENV' already exists."
fi
echo
echo "Setting up for environment: $ENV"
echo "You will be prompted for each value. For secrets, your input will be hidden."
echo "---"

# 4. Set secrets
echo "Setting secrets..."

ask_secret "Enter SF_CONSUMER_KEY (from Salesforce Deploy App):"
if [[ -n "$REPLY" ]]; then
    echo "$REPLY" | gh secret set SF_CONSUMER_KEY --env "$ENV"
    echo "✓ Secret 'SF_CONSUMER_KEY' set."
else
    echo "Skipped SF_CONSUMER_KEY."
fi

ask "Enter SF_USERNAME (e.g., deploy@iot-dev.example.com):" ""
if [[ -n "$REPLY" ]]; then
    echo "$REPLY" | gh secret set SF_USERNAME --env "$ENV"
    echo "✓ Secret 'SF_USERNAME' set."
else
    echo "Skipped SF_USERNAME."
fi

ask "Enter path to your Salesforce JWT private key file:" "server-deploy.key"
KEY_FILE=$REPLY
if [[ -f "$KEY_FILE" ]]; then
    # The deploy workflow expects the key to be base64 encoded.
    base64 -i "$KEY_FILE" | gh secret set SF_JWT_KEY --env "$ENV"
    echo "✓ Secret 'SF_JWT_KEY' set from '$KEY_FILE' (base64 encoded)."
else
    echo "Warning: File '$KEY_FILE' not found. Skipped SF_JWT_KEY."
fi

ask "Enter AWS_ROLE_ARN (for OIDC):" ""
if [[ -n "$REPLY" ]]; then
    echo "$REPLY" | gh secret set AWS_ROLE_ARN --env "$ENV"
    echo "✓ Secret 'AWS_ROLE_ARN' set."
else
    echo "Skipped AWS_ROLE_ARN."
fi

echo "---"

# 5. Set variables
echo "Now setting variables (values will be visible)."

ask "Enter AWS_REGION:" "us-east-1"
if [[ -n "$REPLY" ]]; then
    gh variable set AWS_REGION --body "$REPLY" --env "$ENV"
    echo "✓ Variable 'AWS_REGION' set."
else
    echo "Skipped AWS_REGION."
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

echo
echo "---"
echo "✅ Setup complete for environment '$ENV'."
echo "You can add more secrets/variables to this script as needed."