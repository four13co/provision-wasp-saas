#!/usr/bin/env bash
set -euo pipefail

# Creates a 1Password Service Account for this repo, grants read-only access
# to the per-project vaults (dev/prod), and stores the token in GitHub secrets.
#
# Requirements:
# - op CLI authenticated with an admin capable of creating service accounts
# - gh CLI authenticated with repo admin rights
# - jq available (for JSON parsing)
#
# Usage:
#   ./scripts/op-service-account.sh <owner/repo> [project-dev] [project-prod]
#

get_next_version() {
  local repo_name="$1"
  date +%Y%m%d%H%M%S
}

OWNER_REPO=${1:-${GITHUB_REPOSITORY:-"example/sample"}}
REPO_NAME="${OWNER_REPO#*/}"
VAULT_DEV=${2:-"${REPO_NAME}-dev"}
VAULT_PROD=${3:-"${REPO_NAME}-prod"}
VERSION=$(get_next_version "$REPO_NAME")
SA_NAME="${REPO_NAME}-sa-v${VERSION}"

echo "Repo      : $OWNER_REPO"
echo "Vault Dev : $VAULT_DEV"
echo "Vault Prod: $VAULT_PROD"
echo "SA Name   : $SA_NAME"

if ! command -v op >/dev/null 2>&1; then
  echo "op CLI not found. Install 1Password CLI v2 and sign in." >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found. Install GitHub CLI and authenticate (gh auth login)." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found. Please install jq to parse JSON." >&2
  exit 1
fi

echo "Creating service account..."
# Use the documented syntax: create and grant vault access in one command, returning the token once.
set +e
if [ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
  SA_TOKEN="$OP_SERVICE_ACCOUNT_TOKEN"
else
  SA_TOKEN=$(op service-account create "$SA_NAME" \
    --vault "$VAULT_DEV:read_items" \
    --vault "$VAULT_PROD:read_items" \
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

# Grants were applied at creation using --vault flags.

echo "Storing token in GitHub secrets..."
gh secret set OP_SERVICE_ACCOUNT_TOKEN --repo "$OWNER_REPO" --body "$SA_TOKEN"
gh secret set OP_VAULT_DEV --repo "$OWNER_REPO" --body "$VAULT_DEV"
gh secret set OP_VAULT_PROD --repo "$OWNER_REPO" --body "$VAULT_PROD"

echo "Done. Service account created and GitHub secrets updated for $OWNER_REPO"
