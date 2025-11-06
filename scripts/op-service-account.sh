#!/usr/bin/env bash
set -euo pipefail

# Creates a 1Password Service Account for a specific environment (dev or prod),
# grants read-only access to the environment vault, and stores the token in GitHub secrets.
#
# Requirements:
# - op CLI authenticated with an admin capable of creating service accounts
# - gh CLI authenticated with repo admin rights
#
# Usage:
#   ./scripts/op-service-account.sh <owner/repo> <vault-name> <env-suffix>
#
# Example:
#   ./scripts/op-service-account.sh gregflint/myapp myapp-prod prod
#

get_next_version() {
  date +%Y%m%d%H%M%S
}

OWNER_REPO=${1:-${GITHUB_REPOSITORY:-"example/sample"}}
VAULT_NAME=${2:?"Vault name is required"}
ENV_SUFFIX=${3:?"Environment suffix (dev/prod) is required"}

REPO_NAME="${OWNER_REPO#*/}"
VERSION=$(get_next_version "$REPO_NAME")
SA_NAME="${REPO_NAME}-sa-${ENV_SUFFIX}-v${VERSION}"

# Convert env suffix to uppercase for secret names
ENV_UPPER=$(echo "$ENV_SUFFIX" | tr '[:lower:]' '[:upper:]')

echo "Repo         : $OWNER_REPO"
echo "Vault        : $VAULT_NAME"
echo "Environment  : $ENV_SUFFIX"
echo "SA Name      : $SA_NAME"

if ! command -v op >/dev/null 2>&1; then
  echo "op CLI not found. Install 1Password CLI v2 and sign in." >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found. Install GitHub CLI and authenticate (gh auth login)." >&2
  exit 1
fi

echo "Creating service account..."
# Use the documented syntax: create and grant vault access in one command, returning the token once.
set +e
if [ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
  SA_TOKEN="$OP_SERVICE_ACCOUNT_TOKEN"
else
  SA_TOKEN=$(op service-account create "$SA_NAME" \
    --vault "$VAULT_NAME:read_items" \
    --raw 2>/dev/null)
fi
set -e

if [ -z "$SA_TOKEN" ]; then
  cat >&2 <<EOF
Failed to create service account or retrieve token.
Ensure your 1Password CLI supports 'op service-account create' and you're signed in.
Alternatively, create it in the UI and re-run with OP_SERVICE_ACCOUNT_TOKEN set.
EOF
  exit 1
fi

# Store environment-specific secrets in GitHub
echo "Storing secrets in GitHub..."
gh secret set "OP_SERVICE_ACCOUNT_TOKEN_${ENV_UPPER}" --repo "$OWNER_REPO" --body "$SA_TOKEN"
gh secret set "OP_VAULT_${ENV_UPPER}" --repo "$OWNER_REPO" --body "$VAULT_NAME"

echo "Done. Service account '$SA_NAME' created for $ENV_SUFFIX environment"
echo "GitHub secrets: OP_SERVICE_ACCOUNT_TOKEN_${ENV_UPPER}, OP_VAULT_${ENV_UPPER}"
