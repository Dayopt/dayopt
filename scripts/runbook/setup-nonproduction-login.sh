#!/usr/bin/env bash
# Synchronize the dedicated nonproduction login inputs from 1Password into the
# protected GitHub Environment. Values stay in process memory and stdin only.
set -euo pipefail
set +x

REPO='Dayopt/dayopt'
ENVIRONMENT='Nonproduction login'
LOGIN_ITEM_ID='s3tems3afbzvvguakggydcgxni'
OP_BIN_DIR="${OP_BIN_DIR:-/workspace/.dayopt-1password/bin}"
OP_STARTUP_CHECK="${OP_STARTUP_CHECK:-/workspace/.dayopt-1password/startup-check.py}"
EXECUTE=false
for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=true ;;
    *) echo 'Usage: setup-nonproduction-login.sh [--execute]' >&2; exit 2 ;;
  esac
done

if [[ ! -f "$OP_STARTUP_CHECK" ]]; then
  echo '1Password startup check is missing; set OP_STARTUP_CHECK to the approved checker; no changes made.' >&2
  exit 1
fi
if ! python3 "$OP_STARTUP_CHECK" >/dev/null 2>&1; then
  echo '1Password startup check failed; no changes made.' >&2
  exit 1
fi

if ! $EXECUTE; then
  echo 'Dry run: would sync the dedicated login and scoped Supabase Management PAT into the Nonproduction login environment.'
  exit 0
fi

export PATH="$OP_BIN_DIR:$PATH"
if ! command -v op >/dev/null || ! command -v gh >/dev/null; then
  echo 'Required 1Password or GitHub CLI is unavailable; no changes made.' >&2
  exit 1
fi
if [[ -z "${NONPROD_LOGIN_VAULT_ID:-}" ]]; then
  echo 'NONPROD_LOGIN_VAULT_ID is required to resolve the owner-managed login item; no changes made.' >&2
  exit 1
fi
provision_vault="${NONPROD_LOGIN_PROVISION_VAULT_ID:-ci}"
if [[ ! "$provision_vault" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo 'NONPROD_LOGIN_PROVISION_VAULT_ID must be a vault ID; no changes made.' >&2
  exit 1
fi

read_item_field() {
  local item="$1" field="$2" result
  if ! result="$(op item get "$item" --vault "$NONPROD_LOGIN_VAULT_ID" --fields "$field" --reveal 2>/dev/null)" || [[ -z "$result" ]]; then
    echo "1Password read failed for a required field ($field); no GitHub writes made." >&2
    return 1
  fi
  printf '%s' "$result"
}

# Resolve and validate all source values before the first GitHub mutation.
login_email="$(read_item_field "$LOGIN_ITEM_ID" username)" || exit 1
login_password="$(read_item_field "$LOGIN_ITEM_ID" password)" || exit 1
provision_token="$(op read "op://$provision_vault/supabase-preview-provision/credential" 2>/dev/null)" || {
  echo '1Password read failed for the scoped Supabase Management PAT; no GitHub writes made.' >&2
  exit 1
}
if [[ -z "$login_email" || -z "$login_password" || -z "$provision_token" ]]; then
  echo 'A required 1Password value is empty; no GitHub writes made.' >&2
  exit 1
fi

deployment_policy="$(gh api "repos/$REPO/environments/$ENVIRONMENT" \
  --jq '.deployment_branch_policy | [.protected_branches, .custom_branch_policies] | @tsv' 2>/dev/null)" || {
  echo 'GitHub Environment policy read failed; no secret writes attempted.' >&2
  exit 1
}
if [[ "$deployment_policy" != $'false\ttrue' ]]; then
  echo 'GitHub Environment is not restricted to explicit branch policies; no secret writes made.' >&2
  exit 1
fi

policy_list="$(gh api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
  --jq '.branch_policies[] | [.type, .name] | @tsv' 2>/dev/null)" || {
  echo 'GitHub branch policy read failed; no secret writes attempted.' >&2
  exit 1
}
while IFS=$'\t' read -r policy_type policy_name; do
  [[ -z "$policy_type" && -z "$policy_name" ]] && continue
  if [[ "$policy_type" != branch || ( "$policy_name" != main && "$policy_name" != integration ) ]]; then
    echo 'Unexpected GitHub branch policy exists; review it manually before syncing.' >&2
    exit 1
  fi
done <<< "$policy_list"
for branch in main integration; do
  if ! grep -Fxq $'branch\t'"$branch" <<< "$policy_list"; then
    if ! gh api -X POST "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
      -f name="$branch" -f type=branch >/dev/null 2>&1; then
      echo 'GitHub branch policy setup failed; no secret writes attempted.' >&2
      exit 1
    fi
  fi
done

set_secret() {
  local name="$1" variable_name="$2" value
  value="${!variable_name}"
  if ! printf '%s' "$value" | gh secret set "$name" --env "$ENVIRONMENT" --repo "$REPO" >/dev/null 2>&1; then
    echo "GitHub secret sync failed ($name)." >&2
    return 1
  fi
}
set_secret NONPROD_LOGIN_EMAIL login_email || exit 1
set_secret NONPROD_LOGIN_PASSWORD login_password || exit 1
set_secret SUPABASE_PREVIEW_PROVISION_TOKEN provision_token || exit 1
unset login_email login_password provision_token provision_vault
echo 'Nonproduction login secrets synchronized; values were not displayed or written to files.'
