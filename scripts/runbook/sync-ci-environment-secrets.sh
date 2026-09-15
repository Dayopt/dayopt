#!/bin/bash
# CI の GitHub Secret を 1Password ci vault から main 限定の environment へ同期する。
#
# 使う場面: environment の初回作成（2026-09-14、ci vault 整理）と、ci vault の token を
# rotation した後の replica 更新（docs/operations/secrets.md §GitHub Secrets）。
# 一覧は scripts/tasks/env/schema.ts の ciSecretSchema と 1:1 で、
# scripts/__tests__/ci-secret-ledger.test.ts が一致を検査する。
#
# - User の terminal で実行する（agent の PAT には Secrets / Environments 権限が無い）
# - 値は 1Password から pipe で gh へ渡し、画面にもファイルにも出さない
# - 既定は dry-run。実行する時だけ --execute を付ける
# - repo 単位の Secret はこの script では消さない（environment 移行後は User が消す）
# - --only <名前> で 1 つだけ同期する（rotation 時）
set -euo pipefail

REPO="Dayopt/dayopt"
EXECUTE=false
ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=true ;;
    --only) ONLY="${2:?--only には GitHub Secret 名を渡す}"; shift ;;
    *) echo "Usage: $0 [--execute] [--only <GitHub Secret 名>]" >&2; exit 1 ;;
  esac
  shift
done

# User 本人の gh（admin）を使う。agent 用の GH_CONFIG_DIR が入っていれば外す
unset GH_CONFIG_DIR

ensure_environment() {
  local env="$1"
  echo "== environment: $env（main だけから使える）"
  if $EXECUTE; then
    printf '%s' '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
      gh api -X PUT "repos/$REPO/environments/$env" --input - >/dev/null
    if ! gh api "repos/$REPO/environments/$env/deployment-branch-policies" \
      --jq '.branch_policies[] | select(.name == "main" and .type == "branch") | .name' | grep -qx main; then
      gh api -X POST "repos/$REPO/environments/$env/deployment-branch-policies" \
        -f name=main -f type=branch >/dev/null
    fi
    echo "   branch policy: $(gh api "repos/$REPO/environments/$env/deployment-branch-policies" --jq '[.branch_policies[] | "\(.type):\(.name)"] | join(", ")')"
  else
    echo "[dry-run] environment $env を作成（既存なら更新）し、branch policy に main を足す"
  fi
}

# secret <environment> <GitHub Secret 名> <op:// 参照>
secret() {
  local env="$1" name="$2" ref="$3"
  [[ -n "$ONLY" && "$ONLY" != "$name" ]] && return 0
  if $EXECUTE; then
    op read "$ref" | gh secret set "$name" --env "$env" --repo "$REPO" >/dev/null
    echo "   set $env / $name"
  else
    echo "[dry-run] $env / $name <- $ref"
  fi
}

ensure_environment production-release
secret production-release VERCEL_TOKEN "op://ci/vercel-production/VERCEL_TOKEN"
secret production-release VERCEL_ORG_ID "op://ci/vercel-production/VERCEL_TEAM_ID"
secret production-release VERCEL_AUTOMATION_BYPASS_PRODUCT "op://ci/vercel-production/VERCEL_AUTOMATION_BYPASS_PRODUCT"
secret production-release VERCEL_AUTOMATION_BYPASS_WEB "op://ci/vercel-production/VERCEL_AUTOMATION_BYPASS_WEB"

ensure_environment production-ops
secret production-ops VERCEL_TOKEN "op://ci/vercel-production/VERCEL_TOKEN"
secret production-ops VERCEL_ORG_ID "op://ci/vercel-production/VERCEL_TEAM_ID"
secret production-ops SUPABASE_AUTH_AUDIT_TOKEN "op://ci/supabase-auth-audit/credential"
secret production-ops SUPABASE_STORAGE_RLS_AUDIT_TOKEN "op://ci/supabase-storage-rls-audit/credential"
secret production-ops RCLONE_CONFIG_SOURCE_TYPE "op://ci/Supabase-StorageS3-backupsource/RCLONE_CONFIG_SOURCE_TYPE"
secret production-ops RCLONE_CONFIG_SOURCE_PROVIDER "op://ci/Supabase-StorageS3-backupsource/RCLONE_CONFIG_SOURCE_PROVIDER"
secret production-ops RCLONE_CONFIG_SOURCE_ENDPOINT "op://ci/Supabase-StorageS3-backupsource/RCLONE_CONFIG_SOURCE_ENDPOINT"
secret production-ops RCLONE_CONFIG_SOURCE_REGION "op://ci/Supabase-StorageS3-backupsource/RCLONE_CONFIG_SOURCE_REGION"
secret production-ops RCLONE_CONFIG_SOURCE_ACCESS_KEY_ID "op://ci/Supabase-StorageS3-backupsource/RCLONE_CONFIG_SOURCE_ACCESS_KEY_ID"
secret production-ops RCLONE_CONFIG_SOURCE_SECRET_ACCESS_KEY "op://ci/Supabase-StorageS3-backupsource/RCLONE_CONFIG_SOURCE_SECRET_ACCESS_KEY"
secret production-ops RCLONE_CONFIG_DEST_TYPE "op://ci/Cloudflare-R2-storagebackup/RCLONE_CONFIG_DEST_TYPE"
secret production-ops RCLONE_CONFIG_DEST_PROVIDER "op://ci/Cloudflare-R2-storagebackup/RCLONE_CONFIG_DEST_PROVIDER"
secret production-ops RCLONE_CONFIG_DEST_ENDPOINT "op://ci/Cloudflare-R2-storagebackup/RCLONE_CONFIG_DEST_ENDPOINT"
secret production-ops RCLONE_CONFIG_DEST_REGION "op://ci/Cloudflare-R2-storagebackup/RCLONE_CONFIG_DEST_REGION"
secret production-ops RCLONE_CONFIG_DEST_ACCESS_KEY_ID "op://ci/Cloudflare-R2-storagebackup/RCLONE_CONFIG_DEST_ACCESS_KEY_ID"
secret production-ops RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY "op://ci/Cloudflare-R2-storagebackup/RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY"

echo
if $EXECUTE; then
  for env in production-release production-ops; do
    echo "== $env の Secret（名前だけ）"
    gh secret list --env "$env" --repo "$REPO" | awk '{print "   " $1}'
  done
else
  echo "dry-run でした。内容が正しければ --execute を付けて再実行してください。"
fi
